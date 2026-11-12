"""根据已保存故事和用户原话生成摘要，保存成功后才完成节点。"""

import json

from langchain_core.messages import HumanMessage

from ...service.story import StoryRepository
from ..llm import call_qwen
from ..prompt import load_story_summary_system_prompt
from ..state import WorkflowState


def summary_node(
    state: WorkflowState, *, repository: StoryRepository | None = None,
) -> WorkflowState:
    """复用已保存摘要；缺失时只生成摘要，不改写故事或访谈消息。"""
    if state.get("interview_finished") is not True:
        raise ValueError("访谈尚未结束，不能生成故事摘要")
    if repository is None:
        raise RuntimeError("摘要节点未配置 StoryRepository")
    user_id, story_id = state.get("user_id"), state.get("story_id")
    if type(user_id) is not int or user_id <= 0:
        raise ValueError("摘要节点缺少有效的 user_id")
    if type(story_id) is not int or story_id <= 0:
        raise ValueError("摘要节点缺少有效的 story_id")

    options = {'revision_id': state['revision_id']} if state.get('revision_id') else {}
    story = repository.get_for_summary(user_id=user_id, story_id=story_id, **options)
    if story is None:
        raise ValueError("未找到该用户的故事")
    existing = story.get("summary")
    if isinstance(existing, str) and existing.strip():
        return {"summary": existing.strip(), **({"revision_status": "completed"} if options else {})}
    if any(not isinstance(story.get(key), str) or not story[key].strip() for key in ("title", "body")):
        raise ValueError("已保存故事缺少有效标题或正文")

    materials = _user_materials(state)
    raw = call_qwen([
        ("system", load_story_summary_system_prompt()),
        ("user", json.dumps({
            "story": {"title": story["title"], "body": story["body"]},
            "user_materials": materials,
        }, ensure_ascii=False)),
    ], json_output=True)
    payload = json.loads(raw)
    if not isinstance(payload, dict) or set(payload) != {"summary"}:
        raise ValueError("摘要回复必须且只能包含 summary 字符串")
    generated = _valid_summary(payload["summary"])
    saved = repository.set_summary(user_id=user_id, story_id=story_id, summary=generated, **options)
    return {"summary": _valid_summary(saved), **({"revision_status": "completed"} if options else {})}


def _user_materials(state: WorkflowState) -> list[dict[str, str]]:
    """仅传入本场用户原始文字及其来源编号，不携带图片或助手消息。"""
    materials = []
    source_ids = set()
    for message in state.get("messages", []):
        if not isinstance(message, HumanMessage):
            continue
        text = message.content
        if not isinstance(text, str):
            raise ValueError("摘要事实依据必须是用户原始文字")
        if not text.strip() or text.strip().casefold() in {"退出", "exit", "quit"}:
            continue
        if not message.id or not message.id.strip() or message.id in source_ids:
            raise ValueError("摘要素材的消息 ID 必须非空且唯一")
        source_ids.add(message.id)
        materials.append({"source_turn_id": message.id, "user_text": text})
    if not materials:
        raise ValueError("本次访谈没有可概括的用户原始文字")
    return materials


def _valid_summary(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 600:
        raise ValueError("故事摘要必须是 600 字以内的非空字符串")
    return value.strip()

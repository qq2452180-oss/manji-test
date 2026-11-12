"""结合完整问答理解用户讲述，生成标题与正文并保存。"""

import json

from langchain_core.messages import AIMessage, HumanMessage

from ...service.story import StoryRepository
from ..llm import call_qwen
from ..prompt import load_biography_organizer_system_prompt
from ..state import WorkflowState
from .interview_context import interview_chapter_id, is_global_interview


def writing_node(
    state: WorkflowState, *, repository: StoryRepository | None = None,
) -> WorkflowState:
    """根据本次访谈的原始讲述成文，数据库提交成功后返回故事编号。"""
    if not state.get("interview_finished"):
        raise ValueError("访谈尚未结束，不能成文")
    if repository is None:
        raise RuntimeError("成文节点未配置 StoryRepository")
    user_id = state.get("user_id")
    if type(user_id) is not int or user_id <= 0:
        raise ValueError("成文节点缺少有效的 user_id")
    if state.get('revision_id'):
        revision = repository.get_revision(user_id, state['revision_id'])
        if revision is None:
            raise ValueError('补充记录不存在')
        if revision['applied_version'] is not None:
            return repository.revision_result(revision)
        if revision['status'] == 'conflict':
            from ...service.story import StoryVersionConflict
            raise StoryVersionConflict('故事已被修改，补充内容已保留，请基于最新版重新整理')
        if revision['title'] is not None:
            draft = {'title': revision['title'], 'body': revision['body']}
        else:
            messages = [
                ('system', load_biography_organizer_system_prompt()),
                ('system', '本次是对已有故事的补充。保留原故事中的事实和用户修改，将本次新增原话自然融合为一篇完整故事。'
                 '用户本次明确更正的事实优先；不要将参考资料或助手问题当作新事实。返回 title/body 两字段。'),
                ('user', 'Existing Story V1.0\n' + json.dumps(
                    {key: revision['base_story'][key] for key in ('title', 'body')}, ensure_ascii=False)),
                *build_writing_materials(state),
            ]
            draft = _parse_story_output(call_qwen(messages, json_output=True))
        revision = repository.apply_revision(user_id, revision['id'], revision['attempt'], **draft)
        return repository.revision_result(revision)
    source_session_id = state.get("source_session_id")
    saved = None
    if source_session_id is not None:
        if not isinstance(source_session_id, str) or not source_session_id.strip():
            raise ValueError("成文节点缺少有效的来源会话")
        saved = repository.get_by_session(user_id, source_session_id)
        if saved is not None and (saved.get("chapter_id") is not None or is_global_interview(state)):
            # 会话快照恢复到 writing 时，正文可能早已提交，只补后续未完成步骤。
            return {key: value for key, value in saved.items() if value is not None or key == "chapter_id"}
    chapter_id = interview_chapter_id(state)
    if chapter_id is None and not is_global_interview(state):
        raise ValueError("访谈缺少所属章节，请先从章节话题开始访谈")
    if saved is not None:
        # 兼容旧流程只写入正文的记录：按本场话题补齐章节，不再次生成正文。
        saved["chapter_id"] = repository.restore_chapter(user_id, saved["story_id"], chapter_id)
        return {key: value for key, value in saved.items() if value is not None or key == "chapter_id"}
    messages = _build_writing_messages(state)
    raw = call_qwen(messages, json_output=True)
    draft = _parse_story_output(raw)
    draft["chapter_id"] = chapter_id
    if source_session_id is not None:
        draft["source_session_id"] = source_session_id
    story_id = repository.create(
        user_id=user_id, **draft,
    )
    if source_session_id is not None:
        # 另一个进程可能先保存了同场结果；后续节点必须使用实际入库的正文。
        saved = repository.get_by_session(user_id, source_session_id)
        if saved is None:
            raise RuntimeError("故事已提交，但暂时无法读取保存结果，请继续整理")
        return {key: value for key, value in saved.items() if value is not None or key == "chapter_id"}
    return {
        **draft, "story_id": story_id,
        "profile_processed": False, "life_event_processed": False,
    }


def build_writing_materials(state: WorkflowState) -> list[tuple[str, str]]:
    """将完整问答作为资料提供，仍以有效用户文字判断是否可以开始成文。"""
    transcript = []
    source_ids = set()
    has_user_material = False
    for message in state.get("messages", []):
        if not isinstance(message, (HumanMessage, AIMessage)):
            continue
        text = message.content
        if not isinstance(text, str):
            raise ValueError("成文问答必须是原始文字")
        is_user = isinstance(message, HumanMessage)
        # 仅过滤用户的完整退出命令，保留讲述中出现这些词语的经历。
        if not text.strip() or (is_user and text.strip().casefold() in {"退出", "exit", "quit"}):
            continue
        if not message.id or not message.id.strip() or message.id in source_ids:
            raise ValueError("成文素材的消息 ID 必须非空且唯一")
        source_ids.add(message.id)
        has_user_material = has_user_material or is_user
        transcript.append({
            "source_turn_id": message.id,
            "role": "user" if is_user else "assistant",
            "text": text,
        })
    if not has_user_material:
        raise ValueError("本次访谈没有可整理的用户内容")
    # 旧助手消息只作为资料，不作为此次写作调用的 assistant 历史。
    return [("user", json.dumps(
        {"format": "interview_transcript_v2", "messages": transcript},
        ensure_ascii=False, separators=(",", ":"),
    ))]


def _build_writing_messages(state: WorkflowState) -> list[tuple[str, str]]:
    """统一写作提示词配合带角色与来源编号的完整问答资料。"""
    return [
        ("system", load_biography_organizer_system_prompt()),
        *build_writing_materials(state),
    ]


def _parse_story_output(raw: str) -> WorkflowState:
    """接受 title/body 两字段，兼容旧解析器允许的完整 JSON 围栏。"""
    lines = raw.strip().splitlines()
    if len(lines) >= 3 and lines[0].strip().casefold() in {"```", "```json"}:
        if lines[-1].strip() == "```":
            raw = "\n".join(lines[1:-1])
    payload = json.loads(raw)
    if (
        not isinstance(payload, dict)
        or set(payload) != {"title", "body"}
        or any(
            not isinstance(payload[key], str) or not payload[key].strip()
            for key in ("title", "body")
        )
    ):
        raise ValueError("成文模型回复必须且只能包含非空字符串 title 和 body")
    return {"title": payload["title"].strip(), "body": payload["body"].strip()}

"""结合话题和记忆生成首问，随后逐轮接收输入并追加访谈回复。"""

from copy import deepcopy
import json

from langchain_core.messages import AIMessage, HumanMessage

from ...common.dialogue.message_ids import next_message_id
from ..llm import call_qwen
from ..prompt import load_interview_system_prompt
from ..state import WorkflowState
from .opening_context import (
    first_opening_context, opening_context_data, saved_opening_context, validate_opening_context,
)
from .interview_context import (
    interview_context_data, planning_context_data, saved_interview_context, saved_interview_plan,
)


def interview_node(state: WorkflowState) -> WorkflowState:
    """首问和后续问答共用模型；首条消息持久化本场使用的记忆。"""
    messages = state.get("messages", [])
    metadata = {}
    background = []
    if not messages:
        context = validate_opening_context(state.get("opening_context", first_opening_context()))
        metadata["opening_context"] = context
        interview_context = deepcopy(state.get("interview_context", {}))
        metadata["interview_context"] = interview_context
        background = [("system", opening_context_data(context))]
    else:
        interview_context = saved_interview_context(messages)
    plan = saved_interview_plan(messages)
    if plan is not None:
        background.append(("system", planning_context_data(plan)))
    elif messages:
        context = saved_opening_context(messages)
        if context and context["mode"] == "recap":
            background.append(("system", opening_context_data(context)))
    if interview_context is not None:
        background.append(("system", interview_context_data(interview_context)))
    history = []
    for message in messages:
        if isinstance(message, HumanMessage) and message.additional_kwargs.get("media_ids"):
            content = []
            if message.content:
                content.append({"type": "text", "text": message.content})
            for media_id in message.additional_kwargs["media_ids"]:
                content.append({"type": "image_url", "image_url": {"url": state["image_urls"][media_id]}})
            message = HumanMessage(id=message.id, content=content)
        history.append(message)
    if not messages:
        # 触发首问的指令只用于模型请求，持久化的首条消息仍为助手回复。
        if interview_context.get('supplement_story'):
            history.append(('user', '现在继续补充这篇已有故事。结合 supplement_story 的原故事自然承接，'
                            '邀请用户讲想补充或更正的内容，不要重新介绍自己或重复已经讲过的问题。'))
        else:
            history.append(("user", "现在开始本场访谈，用户尚未回答。结合所选话题与已有记忆，"
                        "生成自然的开场和一个首问。有所选话题时，直接从这个话题中的熟悉活动、生活对象或通常做法进入，"
                        "让简短回答也能带出可继续聊的过去生活，不先泛问成长地、次数或最早记录。没有所选话题时，"
                        "从已有记忆中选一个适合继续聊的真实往事线索；只有用途疑问或没有可用经历时，"
                        "从过去熟悉的一段生活找一个容易回答的入口，明确所聊的人生阶段，不默认询问近况。"
                        "首问只给一个回答任务，不附加其他问题或猜测的选项。"))
    raw = call_qwen([
        ("system", load_interview_system_prompt()),
        *background,
        *history,
    ], json_output=False)
    assistant_text = _reply_text(raw)
    reply = AIMessage(
        id=next_message_id(messages), content=assistant_text, additional_kwargs=metadata,
    )
    if not messages:
        return {"opening_text": assistant_text, "messages": [reply]}
    return {"assistant_text": assistant_text, "messages": [reply]}


def _reply_text(raw: str) -> str:
    """直接使用播报正文；仅兼容明确的旧包装，不把异常数据读给用户。"""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("访谈模型回复为空")
    text = raw.strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return _spoken_text(text)
    # 兼容旧模型的 assistant_text 对象及单对象数组，不扩展到其他字段。
    if isinstance(payload, list) and len(payload) == 1:
        payload = payload[0]
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("assistant_text"), str)
        or not payload["assistant_text"].strip()
    ):
        raise ValueError("访谈模型回复格式无效")
    return _spoken_text(payload["assistant_text"].strip())


def _spoken_text(text: str) -> str:
    # 旧包装内的正文也必须可播报，不能借 assistant_text 绕过结构检查。
    if "```" in text or any(line.lstrip().startswith(("{", "[")) for line in text.splitlines()):
        raise ValueError("访谈模型回复格式无效")
    return text

"""供轻量访谈 agent 使用的原生工具调用入口，不改变既有纯文本调用。"""

from __future__ import annotations

from collections.abc import Sequence

from langchain_core.messages import AIMessage
from langchain_openai import ChatOpenAI
from openai import APIStatusError, APITimeoutError

from .qwen import (
    QWEN_MODEL,
    ChatMessage,
    ModelAccountUnavailableError,
    _is_account_unavailable,
    _required_env,
    _timeout_seconds,
    qwen_timeout_limit,
)


def agent_timeout_seconds() -> float:
    """返回当前整轮预算；调用方据此计算后续工具轮次的剩余时间。"""
    return float(_timeout_seconds())


def call_qwen_with_tools(
    messages: Sequence[ChatMessage],
    *,
    tools: list[dict],
    tool_choice: str = "auto",
    timeout_seconds: float | None = None,
) -> AIMessage:
    """保留原生 tool_calls；无工具调用时必须返回有效的纯文本正文。

    剩余时间只会收紧既有文字／语音超时上限。此处不执行工具、不循环、
    不重试，由访谈 agent 负责整轮预算及工具结果的回传。
    """
    if not messages:
        raise ValueError("messages cannot be empty")
    with qwen_timeout_limit(timeout_seconds):
        timeout = agent_timeout_seconds()
    model = ChatOpenAI(
        model=QWEN_MODEL,
        api_key=_required_env("API_KEY"),
        base_url=_required_env("BASE_URL"),
        timeout=timeout,
        max_retries=0,
        extra_body={"enable_thinking": False},
    )
    bound = model.bind_tools(tools, tool_choice=tool_choice)
    try:
        response = bound.invoke(list(messages))
    except APITimeoutError as exc:
        raise TimeoutError("Qwen 模型请求超时") from exc
    except APIStatusError as exc:
        if _is_account_unavailable(exc):
            raise ModelAccountUnavailableError() from exc
        raise
    if not isinstance(response, AIMessage):
        raise TypeError("Qwen 模型返回的消息类型无效")
    if response.invalid_tool_calls:
        raise ValueError("Qwen 模型返回的工具调用无效")
    if response.tool_calls:
        if tool_choice == "none":
            raise ValueError("Qwen 模型在最终回复中仍请求调用工具")
        return response
    if not isinstance(response.content, str):
        raise TypeError("Qwen 模型返回的内容不是文本")
    if not response.content.strip():
        raise ValueError("Qwen 模型返回的内容为空")
    return response

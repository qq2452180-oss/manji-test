"""通过百炼 OpenAI 兼容接口调用 Qwen3.8-Max。"""

from __future__ import annotations

import json
import math
import os
from collections.abc import Sequence
from contextlib import contextmanager
from contextvars import ContextVar

from langchain_core.messages import BaseMessage
from langchain_openai import ChatOpenAI
from openai import APIStatusError, APITimeoutError

QWEN_MODEL = "qwen3.8-max"
ChatMessage = BaseMessage | tuple[str, str]
_request_timeout_limit: ContextVar[float | None] = ContextVar("qwen_timeout_limit", default=None)


class ModelAccountUnavailableError(RuntimeError):
    """模型供应商明确拒绝账户状态时使用的安全业务错误。"""

    code = "MODEL_ACCOUNT_UNAVAILABLE"

    def __init__(self) -> None:
        super().__init__("AI 访谈服务暂不可用，请联系管理员检查模型服务账户状态")


def _is_account_unavailable(error: APIStatusError) -> bool:
    # Only structured provider codes identify this condition, never HTTP 400
    # alone or text matching that could misclassify an unrelated bad request.
    if error.code == "Arrearage" or error.type == "Arrearage":
        return True
    body = error.body
    if not isinstance(body, dict):
        return False
    detail = body.get("error", body)
    return isinstance(detail, dict) and any(
        detail.get(field) == "Arrearage" for field in ("code", "type")
    )


@contextmanager
def qwen_timeout_limit(seconds: float | None):
    """仅限制本次图调用的模型等待时间，不改文本／成文请求的全局配置。"""
    if seconds is not None and (
        type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds <= 0
    ):
        raise ValueError("模型超时上限必须为正有限秒数")
    previous = _request_timeout_limit.get()
    limit = min(previous, seconds) if previous is not None and seconds is not None else seconds or previous
    token = _request_timeout_limit.set(limit)
    try:
        yield
    finally:
        _request_timeout_limit.reset(token)


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _timeout_seconds() -> float:
    raw = os.getenv("MANJI_TEXT_TIMEOUT_SECONDS", "").strip() or "60"
    try:
        timeout = float(raw)
    except ValueError:
        raise ValueError("MANJI_TEXT_TIMEOUT_SECONDS 必须是正有限秒数") from None
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("MANJI_TEXT_TIMEOUT_SECONDS 必须是正有限秒数")
    limit = _request_timeout_limit.get()
    return min(timeout, limit) if limit is not None else timeout


def call_qwen(messages: Sequence[ChatMessage], *, json_output: bool = False) -> str:
    """返回模型正文；入口负责加载 .env，本方法不修改进程环境。

    使用 API_KEY、BASE_URL 和 MANJI_TEXT_TIMEOUT_SECONDS。
    固定使用 qwen3.8-max，关闭思考，不自动重试；由调用节点选择是否启用 JSON 输出。
    """

    if not messages:
        raise ValueError("messages cannot be empty")
    model = ChatOpenAI(
        model=QWEN_MODEL,
        api_key=_required_env("API_KEY"),
        base_url=_required_env("BASE_URL"),
        timeout=_timeout_seconds(),
        max_retries=0,
        extra_body={"enable_thinking": False},
        model_kwargs={"response_format": {"type": "json_object"}} if json_output else {},
    )
    try:
        response = model.invoke(list(messages))
    except APITimeoutError as exc:
        raise TimeoutError("Qwen 模型请求超时") from exc
    except APIStatusError as exc:
        if _is_account_unavailable(exc):
            raise ModelAccountUnavailableError() from exc
        raise
    if not isinstance(response.content, str):
        raise TypeError("Qwen 模型返回的内容不是文本")
    text = response.content.strip()
    if not text:
        raise ValueError("Qwen 模型返回的内容为空")
    if json_output:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return text
        if isinstance(payload, list) and len(payload) == 1 and isinstance(payload[0], dict):
            return json.dumps(payload[0], ensure_ascii=False)
    return text

"""通话管理与腾讯 LLM 桥接；外部腾讯请求使用独立鉴权。"""

import json
import logging
import time
import uuid
from typing import Literal

from fastapi import APIRouter, Body, Depends, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field
import psycopg
from starlette.concurrency import run_in_threadpool

from ...common.tencent_rtc import TencentRtcError
from ...service.interview import InterviewError
from ...service.rtc import RtcError
from ..auth.dependencies import get_current_user, get_current_user_id


class RtcRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def handle(request: Request):
            try:
                response = await handler(request)
            except RequestValidationError:
                response = JSONResponse(
                    {"code": "RTC_INVALID_REQUEST", "detail": "通话请求格式无效"},
                    status_code=422,
                )
            except RtcError as exc:
                payload = {"code": exc.code, "detail": str(exc)}
                if exc.call_id is not None:
                    payload["call_id"] = exc.call_id
                response = JSONResponse(payload, status_code=exc.status_code)
            except TencentRtcError as exc:
                # SDK 已脱敏；只在 HTTP 边界转换，服务内部保留原异常。
                status = {"RTC_UNAUTHORIZED": 401, "RTC_INVALID_REQUEST": 422,
                          "RTC_INVALID_CONFIG": 503, "RTC_SDK_UNAVAILABLE": 503}.get(exc.code, 502)
                code = exc.code
                if code == "RTC_UNAUTHORIZED":
                    code = "RTC_EVENT_UNAUTHORIZED" if request.url.path.endswith("/events") else "RTC_BRIDGE_UNAUTHORIZED"
                payload = {"code": code, "detail": str(exc)}
                if "call_id" in request.path_params:
                    payload["call_id"] = request.path_params["call_id"]
                response = JSONResponse(payload, status_code=status)
            except InterviewError as exc:
                code = "RTC_TURN_FAILED" if request.url.path.endswith("/completions") else "RTC_SESSION_NOT_READY"
                response = JSONResponse(
                    {"code": code, "detail": str(exc)}, status_code=exc.status_code,
                )
            except psycopg.Error:
                response = JSONResponse(
                    {"code": "RTC_STORAGE_UNAVAILABLE", "detail": "对话历史暂时不可用，请重试"},
                    status_code=503,
                )
            response.headers["Cache-Control"] = "private, no-store"
            return response

        return handle


router = APIRouter(tags=["访谈通话管理"], route_class=RtcRoute)
MAX_LLM_BODY_BYTES = 256 * 1024
MAX_EVENT_BODY_BYTES = 256 * 1024
_EVENT_LOG = logging.getLogger("uvicorn.error")


class PrepareCall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_request_id: str = Field(
        strict=True, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$",
        description="本次准备通话的唯一请求 ID；重试必须使用相同值",
    )
    resume_message_id: str | None = Field(
        default=None, strict=True, min_length=1, max_length=128,
        description="旧客户端兼容字段；普通通话不执行续播",
    )
    resume_kind: Literal["home_return", "pause_replay", "pause_continue"] | None = None
    resume_request_id: str | None = Field(
        default=None, strict=True, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$",
        description="旧客户端兼容字段；普通通话不生成恢复开场",
    )


class EmptyCallInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _service(request: Request):
    service = request.app.state.rtc
    if service is None:
        raise RtcError("RTC_UNAVAILABLE", "语音通话未启用或配置不完整", 503)
    return service


@router.post("/api/interviews/{session_id}/calls", status_code=201)
def prepare_call(
    session_id: str, body: PrepareCall, request: Request,
    user_id: int = Depends(get_current_user_id),
):
    # 旧页面可能仍携带 resume 字段；接口接收但不传入普通通话服务。
    return _service(request).prepare(user_id, session_id, body.client_request_id)


@router.post("/api/rtc/calls/{call_id}/start")
def start_call(
    call_id: str, request: Request, body: EmptyCallInput | None = Body(default=None),
    user_id: int = Depends(get_current_user_id),
):
    return _service(request).start(user_id, call_id)


@router.get("/api/rtc/calls/{call_id}")
def get_call(
    call_id: str, request: Request, user_id: int = Depends(get_current_user_id),
):
    return _service(request).get(user_id, call_id)


@router.post("/api/rtc/calls/{call_id}/stop")
def stop_call(
    call_id: str, request: Request, body: EmptyCallInput | None = Body(default=None),
    user: dict = Depends(get_current_user),
):
    # 旧游客仍能结束自己的在途通话；准备、启动及继续访问仍要求正式账号。
    return _service(request).stop(user["id"], call_id)


@router.post("/api/rtc/llm/chat/completions")
async def voice_reply(request: Request):
    service = _service(request)
    context = service.verify_bridge(request.headers)
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_LLM_BODY_BYTES:
            raise RtcError("RTC_REQUEST_TOO_LARGE", "语音请求内容过大", 413)
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise RtcError("RTC_INVALID_REQUEST", "语音请求格式无效", 422) from None
    # 腾讯协议只在 HTTP 边界处理，服务收到的就是这一句文字。
    invalid = RtcError("RTC_INVALID_REQUEST", "语音请求需包含本轮用户的纯文字讲述", 422)
    if not isinstance(payload, dict) or payload.get("stream", False) is not False:
        raise invalid
    messages = payload.get("messages")
    if (not isinstance(messages, list) or not 1 <= len(messages) <= 128
            or not isinstance(messages[-1], dict) or messages[-1].get("role") != "user"):
        raise invalid
    text = messages[-1].get("content")
    if not isinstance(text, str) or not text.strip() or len(text) > 20000:
        raise invalid
    result = await run_in_threadpool(service.reply, context, text.strip())
    message = {"role": "assistant", "content": result["assistant_text"]}
    message_id = result.get("assistant_message_id")
    if isinstance(message_id, str) and message_id.strip() and len(message_id) <= 128:
        message["metainfo"] = {"call_id": result["call_id"], "assistant_message_id": message_id}
    return {"id": "chatcmpl-" + uuid.uuid4().hex, "object": "chat.completion", "created": int(time.time()),
            "model": "interview", "choices": [{"index": 0, "message": message, "finish_reason": "stop"}]}


@router.post("/api/rtc/events")
async def receive_event(request: Request):
    """签名有效的 AI 事件只确认收妥；重复和未知任务不触发业务处理。"""
    service = _service(request)
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_EVENT_BODY_BYTES:
            raise RtcError("RTC_REQUEST_TOO_LARGE", "事件通知内容过大", 413)
    service.verify_event(bytes(raw), request.headers)
    invalid = RtcError("RTC_INVALID_EVENT", "事件通知格式无效", 422)
    try:
        event = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise invalid from None
    if not isinstance(event, dict):
        raise invalid
    event_type, info = event.get("EventType"), event.get("EventInfo")
    if (
        type(event.get("EventGroupId")) is not int or event["EventGroupId"] != 9
        or type(event_type) is not int or not 1 <= event_type <= 65535
        or not isinstance(info, dict)
        or not isinstance(info.get("TaskId"), str) or not info["TaskId"].strip()
        or len(info["TaskId"]) > 512
    ):
        raise invalid
    # Only a bounded integer is logged; payload text, task IDs and auth headers stay private.
    _EVENT_LOG.info("RTC event accepted event_type=%d", event_type)
    return {"code": 0}

"""普通语音通话：接通 → submit_voice → 挂断。单进程内存，不另存历史。

接通时播放历史中的最后一条模型回复，再等待用户说话。
"""

from concurrent.futures import Future, TimeoutError
import logging
import secrets
from threading import RLock
import uuid

from ...common.tencent_rtc import TencentRtcError


class RtcError(ValueError):
    def __init__(self, code, message, status_code=400, *, call_id=None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.call_id = call_id


class DirectRtcService:
    def __init__(self, provider, interview):
        self._provider = provider
        self._interview = interview
        self._calls = {}
        self._lock = RLock()

    def prepare(self, user_id, session_id, request_id):
        """返回入房凭据，客户端入房后再调 start。"""
        with self._lock:
            existing = next((c for c in self._calls.values() if c["user_id"] == user_id
                             and c["session_id"] == session_id and c["request_id"] == request_id), None)
            previous = next((c for c in self._calls.values() if c["user_id"] == user_id
                             and c["session_id"] == session_id and not c["stopped"]), None)
        if existing is None:
            self._interview.require_voice_ready(user_id, session_id)
            if previous is not None:
                operation = self.stop if previous["closed"] else self.get
                operation(user_id, previous["call_id"])
            with self._lock:
                # 结束的通话仅保留到下一次拨打，处理中的回复仍能完成保存。
                self._calls = {key: c for key, c in self._calls.items()
                               if c["user_id"] != user_id or not c["stopped"] or c["pending"]}
                existing = next((c for c in self._calls.values() if c["session_id"] == session_id), None)
                if existing is None:
                    room_id = secrets.randbelow(4294967294) + 1
                    while any(c["room_id"] == room_id for c in self._calls.values()):
                        room_id = secrets.randbelow(4294967294) + 1
                    existing = dict(call_id=uuid.uuid4().hex, user_id=user_id, session_id=session_id,
                                    request_id=request_id, room_id=room_id, rtc_user_id="u_" + uuid.uuid4().hex[:30],
                                    task_id=None, started=False, closed=False, stopped=False,
                                    pending=False, error=None, turns={}, lock=RLock())
                    self._calls[existing["call_id"]] = existing
                elif existing["request_id"] != request_id:
                    raise RtcError("RTC_CALL_CONFLICT", "请先挂断当前通话", 409, call_id=existing["call_id"])
        result = self._view(existing)
        if not existing["closed"]:
            result["credentials"] = self._provider.create_join_params(
                existing["rtc_user_id"], existing["room_id"], call_id=existing["call_id"],
            )
        return result

    def start(self, user_id, call_id):
        """同一通电话只启动一次；启停共用这通电话自己的锁。"""
        call = self._owned(user_id, call_id)
        with call["lock"]:
            if call["closed"]:
                return self._view(call)
            if call["started"]:
                return self.get(user_id, call_id)
            self._interview.require_voice_ready(user_id, call["session_id"])
            message = self._interview.get_session(user_id, call["session_id"])["messages"][-1]
            welcome_message = message["content"]
            if message["role"] != "assistant" or not isinstance(welcome_message, str) or not welcome_message.strip():
                raise RtcError("RTC_NOT_READY", "当前没有可播放的问题，请先完成上一轮回复", 409)
            call["started"] = True
            call["task_id"] = self._provider.start_conversation(
                call_id=call_id, room_id=call["room_id"], user_id=call["rtc_user_id"],
                welcome_message=welcome_message,
            )
            return self._view(call)

    def reply(self, context, text):
        """把本轮文字直接交给现有访谈服务；相同请求共享同一个结果。"""
        with self._lock:
            call = next((c for c in self._calls.values()
                         if str(c["room_id"]) == context["room_id"] and c["rtc_user_id"] == context["user_id"]), None)
        if (call is None or context["sdk_app_id"] != str(self._provider.config.sdk_app_id)
                or context["room_id_type"] != "0"):
            raise RtcError("RTC_BRIDGE_FORBIDDEN", "语音请求与通话身份不匹配", 403)
        with call["lock"]:
            self._connected(call)
            # 回包丢失时，已鉴权且房间/用户吻合的腾讯请求可补回任务 ID。
            if call["task_id"] is not None and call["task_id"] != context["task_id"]:
                raise RtcError("RTC_BRIDGE_FORBIDDEN", "语音请求与通话任务不匹配", 403)
            call["task_id"] = context["task_id"]
            turn = call["turns"].get(context["request_id"])
            owner = turn is None
            if turn is not None and turn[0] != text:
                raise RtcError("RTC_REQUEST_CONFLICT", "同一语音请求的内容不一致", 409)
            if owner:
                if call["pending"] or call["error"]:
                    raise RtcError("RTC_TURN_PENDING", "请先处理上一轮回复", 409)
                turn = (text, Future())
                call["turns"][context["request_id"]] = turn
                call["pending"] = True
        future = turn[1]
        if owner:
            response = None
            try:
                result = self._interview.submit_voice(
                    call["user_id"], call["session_id"], text,
                    timeout_seconds=max(0.1, self._provider.config.llm_timeout_seconds - 3),
                )
                if not isinstance(result.get("assistant_text"), str) or not result["assistant_text"].strip():
                    raise RtcError("RTC_TURN_FAILED", "本轮回复未完成", 502)
                response = dict(call_id=call["call_id"], assistant_text=result["assistant_text"],
                                assistant_message_id=result.get("assistant_message_id"))
            finally:
                # 模型或历史保存失败也结束等待；重复请求不能再写一次用户消息。
                with call["lock"]:
                    call["pending"] = False
                    if response is None:
                        error = RtcError("RTC_TURN_FAILED", "请挂断后重试上一轮回复", 502)
                        call["error"] = {"code": error.code, "detail": str(error)}
                        future.set_exception(error)
                    else:
                        future.set_result(response)
                    if call["closed"]:
                        call["turns"].clear()
        try:
            response = future.result(timeout=self._provider.config.llm_timeout_seconds)
        except TimeoutError:
            raise RtcError("RTC_TURN_PENDING", "回复仍在处理中，请稍后重试", 503) from None
        self._connected(call)
        return response

    def stop(self, user_id, call_id):
        """先拒绝新输入，再停止腾讯；已开始生成的回答仍由访谈服务保存。"""
        call = self._owned(user_id, call_id)
        call["closed"] = True
        with call["lock"]:
            if not call["stopped"]:
                if call["started"] and call["task_id"] is None:
                    remote = self._provider.describe_conversation(call_id=call_id)
                    call["task_id"] = remote["TaskId"] if remote else None
                if call["task_id"]:
                    self._provider.stop_conversation(call["task_id"])
                # 查不到未知启动时只结束本地通话，不保证云任务已回收。
                call["stopped"] = True
            if not call["pending"]:
                call["turns"].clear()
            return self._view(call)

    def get(self, user_id, call_id):
        call = self._owned(user_id, call_id)
        with call["lock"]:
            if call["started"] and not call["closed"]:
                remote = self._provider.describe_conversation(**(
                    {"task_id": call["task_id"]} if call["task_id"] else {"call_id": call_id}))
                if remote:
                    call["task_id"] = remote.get("TaskId") or call["task_id"]
                if (remote and remote["Status"] == "Stopped") or (remote is None and call["task_id"]):
                    call["closed"] = call["stopped"] = True
            return self._view(call)

    def close(self):
        for call in list(self._calls.values()):
            if not call["stopped"]:
                try:
                    self.stop(call["user_id"], call["call_id"])
                except TencentRtcError as exc:
                    logging.getLogger(__name__).warning("RTC shutdown incomplete: %s", exc.code)

    def verify_bridge(self, headers):
        return self._provider.verify_llm_request(headers)

    def verify_event(self, body, headers):
        self._provider.verify_callback(body, headers)

    def _owned(self, user_id, call_id):
        with self._lock:
            call = self._calls.get(call_id)
        if call is None or call["user_id"] != user_id:
            raise RtcError("RTC_CALL_NOT_FOUND", "通话不存在，请重新拨打", 404)
        return call

    @staticmethod
    def _connected(call):
        if call["closed"] or not call["started"]:
            raise RtcError("RTC_CALL_CLOSED", "通话未接通或已挂断", 409)

    def _view(self, call):
        status = "ACTIVE" if call["task_id"] else "STARTING" if call["started"] else "PREPARED"
        if call["closed"]:
            status = "STOPPED" if call["stopped"] and not call["pending"] else "STOPPING"
        return {"call_id": call["call_id"], "session_id": call["session_id"], "status": status,
                "task_id": call["task_id"], "sdk_app_id": self._provider.config.sdk_app_id,
                "room_id": call["room_id"], "rtc_user_id": call["rtc_user_id"],
                "turn_pending": call["pending"], "turn_error": call["error"], "last_error": None}

"""普通通话的腾讯接入：官方 SDK 请求、官方签名和回调鉴权。"""

import base64
from dataclasses import dataclass, field
import hashlib
import hmac
import json
import logging
import math
import re
import struct
from threading import local
import time
from urllib.parse import urlsplit


# SDK 的 DEBUG 日志含凭据；只设置一次，不在每次请求中重复处理。
logging.getLogger("tencentcloud_sdk_common").addFilter(lambda record: record.levelno >= logging.WARNING)
_REJECTIONS = {
    "AuthFailure", "UnauthorizedOperation", "InvalidParameter", "InvalidParameterValue",
    "MissingParameter", "UnknownParameter", "UnsupportedOperation", "FailedOperation",
    "LimitExceeded", "RequestLimitExceeded", "ResourceInUse", "ResourceInsufficient",
    "ResourceNotFound", "OperationDenied", "RequestExpired", "InvalidAction", "InvalidRequest",
    "InvalidVersion", "UnsupportedRegion",
}


class TencentRtcError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class TencentRtcConfig:
    sdk_app_id: int
    secret_id: str = field(repr=False)
    secret_key: str = field(repr=False)
    sdk_secret_key: str = field(repr=False)
    llm_api_url: str = field(repr=False)
    llm_api_key: str = field(repr=False)
    llm_model: str
    voice_id: str
    callback_key: str = field(repr=False)
    region: str = "ap-guangzhou"
    tts_model: str = "flow_02_turbo"
    language: str = "zh"
    speed: float = 1.0
    user_sig_ttl_seconds: int = 3600
    llm_timeout_seconds: float = 35.0
    request_timeout_seconds: float = 10.0
    max_idle_seconds: int = 60
    room_auth_enabled: bool = False
    semantic_turn_detection: bool = True
    semantic_eagerness: str = "low"

    def __post_init__(self):
        def require(valid, name):
            if not valid:
                raise TencentRtcError("RTC_INVALID_CONFIG", f"腾讯 RTC 配置无效：{name}")

        for name in ("secret_id", "secret_key", "sdk_secret_key", "llm_api_url", "llm_api_key",
                     "llm_model", "voice_id", "callback_key", "region", "tts_model", "language"):
            value = getattr(self, name)
            require(isinstance(value, str) and bool(value) and value == value.strip() and value.isprintable(), name)
        require(bool(re.fullmatch(r"[A-Za-z0-9]{1,32}", self.callback_key)), "callback_key")
        for name, high in (("sdk_app_id", 4294967295), ("user_sig_ttl_seconds", 86400),
                           ("max_idle_seconds", float("inf"))):
            value = getattr(self, name)
            require(type(value) is int and 0 < value <= high, name)
        for name, low, high in (("speed", 0.5, 2), ("llm_timeout_seconds", 1, 50),
                                ("request_timeout_seconds", 0.001, float("inf"))):
            value = getattr(self, name)
            require(type(value) in (int, float) and low <= value <= high and math.isfinite(value), name)
        for name in ("room_auth_enabled", "semantic_turn_detection"):
            require(type(getattr(self, name)) is bool, name)
        require(self.semantic_eagerness in ("low", "medium", "high", "auto"), "semantic_eagerness")
        try:
            url = urlsplit(self.llm_api_url)
            valid_url = (url.scheme == "https" and bool(url.hostname) and url.port != 0
                         and url.username is None and url.password is None and not url.query
                         and not url.fragment and not any(c.isspace() for c in self.llm_api_url))
        except ValueError:
            valid_url = False
        require(valid_url, "llm_api_url")


class TencentRtcProvider:
    def __init__(self, config, *, client_factory=None):
        self.config = config
        self._client_factory = client_factory or self._new_client
        self._thread = local()  # 每个线程各用一个 SDK client，不让不同电话共用网络锁。

    def create_join_params(self, user_id, room_id, *, call_id):
        c, signer = self.config, self._signer()
        expires = int(time.time()) + c.user_sig_ttl_seconds
        result = dict(sdk_app_id=c.sdk_app_id, room_id=room_id, user_id=user_id,
                      user_sig=signer.gen_sig(user_id, expire=c.user_sig_ttl_seconds),
                      bot_user_id=self._bot_user_id(call_id), expires_at=expires)
        if c.room_auth_enabled:
            # 已安装签名库只提供 gen_sig_with_userbuf；15 为建房、入房及音频收发权限。
            account = user_id.encode("ascii")
            userbuf = (struct.pack(">BH", 0, len(account)) + account
                       + struct.pack(">IIIII", c.sdk_app_id, room_id, expires, 15, 0))
            result["private_map_key"] = signer.gen_sig_with_userbuf(user_id, c.user_sig_ttl_seconds, userbuf)
        return result

    def start_conversation(self, *, call_id, room_id, user_id, welcome_message=""):
        c, bot_id = self.config, self._bot_user_id(call_id)
        agent = dict(UserId=bot_id, UserSig=self._signer().gen_sig(bot_id, expire=c.user_sig_ttl_seconds),
                     TargetUserId=user_id, MaxIdleTime=c.max_idle_seconds, WelcomeMessage=welcome_message,
                     InterruptMode=1, SubtitleMode=1, FilterOneWord=False,
                     TurnDetectionMode=3 if c.semantic_turn_detection else 0)
        if c.semantic_turn_detection:
            agent["TurnDetection"] = {"SemanticEagerness": c.semantic_eagerness}
        result = self._call("StartAIConversation", {
            "SdkAppId": c.sdk_app_id, "RoomId": str(room_id), "RoomIdType": 0, "SessionId": call_id,
            "AgentConfig": agent, "STTConfig": {"Language": c.language,"VadSilenceTime": 1000},
            "LLMConfig": json.dumps(dict(LLMType="openai", Model=c.llm_model, APIUrl=c.llm_api_url,
                                         APIKey=c.llm_api_key, History=0, Streaming=False, Timeout=c.llm_timeout_seconds)),
            "TTSConfig": json.dumps(dict(TTSType="flow", Model=c.tts_model, VoiceId=c.voice_id,
                                         Speed=c.speed, Language=c.language)),
        })
        if not self._valid_id(result.get("TaskId")):
            raise self._uncertain()
        return result["TaskId"]

    def describe_conversation(self, *, task_id=None, call_id=None):
        if (task_id is None) == (call_id is None):
            raise TencentRtcError("RTC_INVALID_REQUEST", "task_id 和 call_id 必须且只能提供一个")
        identity = {"TaskId": task_id} if task_id is not None else {"SessionId": call_id}
        result = self._call("DescribeAIConversation", {"SdkAppId": self.config.sdk_app_id, **identity}, missing_ok=True)
        if result is not None and (result.get("Status") not in ("Idle", "Preparing", "InProgress", "Stopped")
                                   or (call_id is not None and not self._valid_id(result.get("TaskId")))):
            raise self._uncertain()
        return result

    def stop_conversation(self, task_id):
        result = self._call("StopAIConversation", {"TaskId": task_id}, missing_ok=True)
        if result is not None and not self._valid_id(result.get("RequestId")):
            raise self._uncertain()

    def verify_llm_request(self, headers):
        values = self._headers(headers)
        scheme, _, token = values.get("authorization", "").partition(" ")
        if (scheme.lower() != "bearer" or not hmac.compare_digest(token.encode(), self.config.llm_api_key.encode())
                or values.get("x-sdk-app-id") != str(self.config.sdk_app_id)):
            raise TencentRtcError("RTC_UNAUTHORIZED", "腾讯 RTC 请求鉴权失败")
        context = {key: values.get("x-" + key.replace("_", "-"), "") for key in
                   ("sdk_app_id", "task_id", "request_id", "user_id", "room_id", "room_id_type")}
        if (not all(self._valid_id(value) for value in context.values())
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", context["user_id"])
                or context["room_id_type"] != "0" or not re.fullmatch(r"[1-9][0-9]{0,9}", context["room_id"])
                or int(context["room_id"]) > 4294967294):
            raise TencentRtcError("RTC_UNAUTHORIZED", "腾讯 RTC 请求身份无效")
        return context

    def verify_callback(self, body, headers):
        values = self._headers(headers)
        expected = base64.b64encode(hmac.new(self.config.callback_key.encode(), body, hashlib.sha256).digest())
        if (values.get("sdkappid") != str(self.config.sdk_app_id)
                or not hmac.compare_digest(expected, values.get("sign", "").encode())):
            raise TencentRtcError("RTC_UNAUTHORIZED", "腾讯 RTC 事件验签失败")

    def _call(self, action, payload, *, missing_ok=False):
        try:
            from requests.exceptions import RequestException
            from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
            if not hasattr(self._thread, "client"):
                self._thread.client = self._client_factory()
        except ImportError:
            raise TencentRtcError("RTC_SDK_UNAVAILABLE", "缺少腾讯云 RTC SDK 依赖") from None
        try:
            result = self._thread.client.call_json(action, payload)["Response"]
        except TencentCloudSDKException as exc:
            code = exc.code if isinstance(exc.code, str) else ""
            if missing_ok and code == "FailedOperation.TaskNotExist":
                return None
            if code.partition(".")[0] in _REJECTIONS and not (
                    action == "StartAIConversation" and code == "FailedOperation.TaskExist"):
                raise TencentRtcError("RTC_PROVIDER_FAILED", "腾讯拒绝了通话请求，请检查配置") from None
            raise self._uncertain() from None
        except (RequestException, json.JSONDecodeError, UnicodeDecodeError, KeyError, TypeError):
            raise self._uncertain() from None
        if not isinstance(result, dict):
            raise self._uncertain()
        return result

    def _new_client(self):
        from tencentcloud.common.credential import Credential
        from tencentcloud.common.profile.client_profile import ClientProfile
        from tencentcloud.common.profile.http_profile import HttpProfile
        from tencentcloud.common.retry import NoopRetryer
        from tencentcloud.trtc.v20190722.trtc_client import TrtcClient

        c = self.config
        profile = ClientProfile(retryer=NoopRetryer(), httpProfile=HttpProfile(
            endpoint="trtc.tencentcloudapi.com", reqTimeout=c.request_timeout_seconds))
        return TrtcClient(Credential(c.secret_id, c.secret_key), c.region, profile)

    def _signer(self):
        try:
            from TLSSigAPIv2 import TLSSigAPIv2
        except ImportError:
            raise TencentRtcError("RTC_SDK_UNAVAILABLE", "缺少腾讯签名库依赖") from None
        return TLSSigAPIv2(self.config.sdk_app_id, self.config.sdk_secret_key)

    @staticmethod
    def _bot_user_id(call_id):
        return "ai_" + hashlib.sha256(call_id.encode()).hexdigest()[:29]

    @staticmethod
    def _valid_id(value):
        return isinstance(value, str) and re.fullmatch(r"[!-~]{1,1024}", value) is not None

    @staticmethod
    def _headers(headers):
        result = {}
        for key, value in headers.items():
            if (key.lower() in result or not isinstance(value, str)
                    or (value and not value.isprintable())):
                raise TencentRtcError("RTC_UNAUTHORIZED", "腾讯 RTC 请求头无效")
            result[key.lower()] = value
        return result

    @staticmethod
    def _uncertain():
        return TencentRtcError("RTC_PROVIDER_UNCERTAIN", "腾讯通话任务状态待查询确认")

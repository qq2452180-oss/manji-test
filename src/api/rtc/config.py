"""新工作流独立的 RTC 环境配置；未启用时不影响其他接口。"""

from collections.abc import Mapping
import logging
import os
from urllib.parse import urlsplit

from ...common.tencent_rtc import TencentRtcConfig, TencentRtcError, TencentRtcProvider


_LOG = logging.getLogger(__name__)
_PREFIX = "MANJI_LANGGRAPH_RTC_"
_REQUIRED = (
    "secret_id", "secret_key", "sdk_secret_key", "llm_api_url", "llm_api_key",
    "llm_model", "voice_id", "callback_key",
)


def _boolean(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError("invalid RTC boolean")


_OPTIONAL = {
    "room_auth_enabled": _boolean,
    "semantic_turn_detection": _boolean,
    "semantic_eagerness": str,
    "region": str,
    "tts_model": str,
    "language": str,
    "speed": float,
    "user_sig_ttl_seconds": int,
    "llm_timeout_seconds": float,
    "request_timeout_seconds": float,
    "max_idle_seconds": int,
}


def load_rtc_provider(environ: Mapping[str, str] | None = None) -> TencentRtcProvider | None:
    """仅构造 provider，不联网；错误日志不包含环境变量的值。"""
    env = os.environ if environ is None else environ
    enabled = env.get(_PREFIX + "ENABLED", "false").strip().lower()
    if enabled in {"", "0", "false", "no", "off"}:
        return None
    if enabled not in {"1", "true", "yes", "on"}:
        _LOG.warning("新工作流 RTC 未启用：MANJI_LANGGRAPH_RTC_ENABLED 格式无效")
        return None

    try:
        values = {name: env.get(_PREFIX + name.upper(), "") for name in _REQUIRED}
        # 新工作流的每轮语音必须经过自己的桥接接口，不能直连模型或旧访谈服务。
        if not urlsplit(values["llm_api_url"]).path.endswith("/api/rtc/llm/chat/completions"):
            raise ValueError("RTC bridge URL must use the LangGraph completion route")
        values["sdk_app_id"] = int(env.get(_PREFIX + "SDK_APP_ID", ""))
        for name, convert in _OPTIONAL.items():
            key = _PREFIX + name.upper()
            if key in env:
                values[name] = convert(env[key])
        return TencentRtcProvider(TencentRtcConfig(**values))
    except (TypeError, ValueError, OverflowError, TencentRtcError):
        _LOG.warning("新工作流 RTC 未启用：请检查 MANJI_LANGGRAPH_RTC_* 配置")
        return None

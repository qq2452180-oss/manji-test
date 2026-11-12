"""语义断句配置经过真实腾讯 SDK 序列化；云客户端离线替换。"""

from dataclasses import replace
import json
import socket
from unittest.mock import Mock

import pytest
from tencentcloud.trtc.v20190722 import models

from src.api.rtc.config import load_rtc_provider
from src.common.tencent_rtc import TencentRtcConfig, TencentRtcError, TencentRtcProvider


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    forbidden = Mock(side_effect=AssertionError("断句配置测试不可连接网络"))
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)


@pytest.fixture
def config():
    return TencentRtcConfig(
        sdk_app_id=1400000001, secret_id="test-cloud-id", secret_key="test-cloud-key",
        sdk_secret_key="test-sdk-key", llm_api_url="https://test.invalid/api/rtc/llm/chat/completions",
        llm_api_key="test-bridge-key", llm_model="interview", voice_id="test-voice",
        callback_key="testCallbackKey",
    )


@pytest.fixture
def environment(config):
    names = (
        "sdk_app_id", "secret_id", "secret_key", "sdk_secret_key", "llm_api_url",
        "llm_api_key", "llm_model", "voice_id", "callback_key",
    )
    return {
        "MANJI_LANGGRAPH_RTC_ENABLED": "true",
        **{f"MANJI_LANGGRAPH_RTC_{name.upper()}": str(getattr(config, name)) for name in names},
    }


def serialized_agent(config):
    requests = []

    class Client:
        def call_json(self, action, payload):
            assert action == "StartAIConversation"
            # 用已安装 SDK 的模型核验普通请求字段，网络请求仍完全离线。
            request = models.StartAIConversationRequest()
            request.from_json_string(json.dumps(payload))
            requests.append(request._serialize())
            return {"Response": {"TaskId": "test-task", "RequestId": "test-request"}}

    provider = TencentRtcProvider(config, client_factory=Client)
    assert provider.start_conversation(
        call_id="test-call", room_id=123, user_id="test-user",
    ) == "test-task"
    assert len(requests) == 1
    return requests[0]["AgentConfig"]


def test_default_environment_sends_patient_semantic_detection_through_sdk(environment):
    provider = load_rtc_provider(environment)
    assert provider is not None
    assert provider.config.semantic_turn_detection is True
    assert provider.config.semantic_eagerness == "low"
    agent = serialized_agent(provider.config)
    assert agent["TurnDetectionMode"] == 3
    assert agent["TurnDetection"] == {"SemanticEagerness": "low"}
    assert agent["InterruptMode"] == 1


def test_environment_can_restore_automatic_detection_without_semantic_options(environment):
    environment["MANJI_LANGGRAPH_RTC_SEMANTIC_TURN_DETECTION"] = "false"
    provider = load_rtc_provider(environment)
    assert provider is not None
    assert provider.config.semantic_turn_detection is False
    agent = serialized_agent(provider.config)
    assert agent["TurnDetectionMode"] == 0
    assert "TurnDetection" not in agent


@pytest.mark.parametrize("eagerness", ["low", "medium", "high", "auto"])
def test_environment_passes_supported_semantic_eagerness_to_sdk(environment, eagerness):
    environment.update({
        "MANJI_LANGGRAPH_RTC_SEMANTIC_TURN_DETECTION": "true",
        "MANJI_LANGGRAPH_RTC_SEMANTIC_EAGERNESS": eagerness,
    })
    provider = load_rtc_provider(environment)
    assert provider is not None
    agent = serialized_agent(provider.config)
    assert agent["TurnDetectionMode"] == 3
    assert agent["TurnDetection"] == {"SemanticEagerness": eagerness}


@pytest.mark.parametrize("name,value", [
    ("semantic_turn_detection", 1),
    ("semantic_turn_detection", "false"),
    ("semantic_eagerness", ""),
    ("semantic_eagerness", "urgent"),
    ("semantic_eagerness", ["low"]),
])
def test_direct_config_rejects_wrong_types_and_unsupported_values(config, name, value):
    with pytest.raises(TencentRtcError) as caught:
        replace(config, **{name: value})
    assert caught.value.code == "RTC_INVALID_CONFIG"
    assert name in str(caught.value)


@pytest.mark.parametrize("suffix,value", [
    ("SEMANTIC_TURN_DETECTION", "invalid-boolean"),
    ("SEMANTIC_EAGERNESS", "invalid-eagerness"),
])
def test_invalid_semantic_environment_disables_provider_without_logging_values(
    environment, suffix, value, caplog,
):
    environment[f"MANJI_LANGGRAPH_RTC_{suffix}"] = value
    assert load_rtc_provider(environment) is None
    assert "请检查 MANJI_LANGGRAPH_RTC_* 配置" in caplog.text
    assert value not in caplog.text

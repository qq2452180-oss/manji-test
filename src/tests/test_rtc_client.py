"""腾讯接入的离线契约：真实签名、原始协议、鉴权与线程隔离。"""

import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import hmac
import json
import logging
import socket
import struct
from threading import Event, Lock
import time
from types import SimpleNamespace
from unittest.mock import Mock
import zlib

import pytest
from requests.exceptions import Timeout
from starlette.datastructures import Headers
from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
from tencentcloud.common.retry import NoopRetryer
from tencentcloud.trtc.v20190722.trtc_client import TrtcClient

from src.common.tencent_rtc.client import TencentRtcConfig, TencentRtcError, TencentRtcProvider


CALL_ID = "a" * 32
ROOM_ID = 123
USER_ID = "test-user"
NOW = 1700000000


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    forbidden = Mock(side_effect=AssertionError("腾讯接入测试不可连接网络或数据库"))
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr("psycopg.connect", forbidden)
    yield
    forbidden.assert_not_called()


@pytest.fixture
def config():
    return TencentRtcConfig(
        sdk_app_id=1400000001, secret_id="test-cloud-id", secret_key="private-cloud-secret",
        sdk_secret_key="private-sdk-secret", llm_api_url="https://test.invalid/api/rtc/llm/chat/completions",
        llm_api_key="private-bridge-key", llm_model="interview", voice_id="test-voice",
        callback_key="testCallbackKey", user_sig_ttl_seconds=600,
    )


@pytest.fixture
def transport(config):
    client = SimpleNamespace(call_json=Mock(return_value={
        "Response": {"TaskId": "test-task", "RequestId": "cloud-request"},
    }))
    return SimpleNamespace(client=client, provider=TencentRtcProvider(config, client_factory=lambda: client))


def start(provider):
    return provider.start_conversation(call_id=CALL_ID, room_id=ROOM_ID, user_id=USER_ID)


def decode_signature(value, key):
    encoded = value.replace("*", "+").replace("-", "/").replace("_", "=")
    payload = json.loads(zlib.decompress(base64.b64decode(encoded)))
    signed = "".join(f"{name}:{payload[name]}\n" for name in (
        "TLS.identifier", "TLS.sdkappid", "TLS.time", "TLS.expire",
    ))
    if "TLS.userbuf" in payload:
        signed += f"TLS.userbuf:{payload['TLS.userbuf']}\n"
    expected = base64.b64encode(hmac.new(key.encode(), signed.encode(), hashlib.sha256).digest()).decode()
    assert hmac.compare_digest(payload["TLS.sig"], expected)
    return payload


def llm_headers(config):
    return {"Authorization": f"Bearer {config.llm_api_key}", "X-Sdk-App-Id": str(config.sdk_app_id),
            "X-Task-Id": "test-task", "X-Request-Id": "voice-request", "X-User-Id": USER_ID,
            "X-Room-Id": str(ROOM_ID), "X-Room-Id-Type": "0"}


def event_headers(config, body):
    signature = base64.b64encode(hmac.new(config.callback_key.encode(), body, hashlib.sha256).digest()).decode()
    return {"SdkAppId": str(config.sdk_app_id), "Sign": signature}


def duplicate_header(headers, name):
    raw = [(key.lower().encode(), value.encode()) for key, value in headers.items()]
    raw.append((name.lower().encode(), headers[name].encode()))
    return Headers(raw=raw)


@pytest.mark.parametrize("field", ["secret_id", "secret_key"])
@pytest.mark.parametrize("padding", [" {value}", "{value} "])
def test_credentials_reject_surrounding_spaces_before_sdk_initialization(config, field, padding):
    value = padding.format(value=getattr(config, field))
    with pytest.raises(TencentRtcError) as caught:
        replace(config, **{field: value})
    assert caught.value.code == "RTC_INVALID_CONFIG"
    assert field in str(caught.value)
    assert value not in str(caught.value)


def test_join_params_contain_valid_user_signature_and_bot_identity(config, monkeypatch):
    monkeypatch.setattr(time, "time", lambda: NOW)
    provider = TencentRtcProvider(config)
    result = provider.create_join_params(USER_ID, ROOM_ID, call_id=CALL_ID)
    signature = decode_signature(result["user_sig"], config.sdk_secret_key)
    assert signature["TLS.sdkappid"] == config.sdk_app_id
    assert signature["TLS.identifier"] == USER_ID
    assert signature["TLS.time"] == NOW
    assert signature["TLS.expire"] == config.user_sig_ttl_seconds
    assert result["expires_at"] == NOW + config.user_sig_ttl_seconds
    assert result["room_id"] == ROOM_ID and result["user_id"] == USER_ID
    assert result["bot_user_id"] != USER_ID
    assert 1 <= len(result["bot_user_id"]) <= 32
    assert "private_map_key" not in result


def test_private_map_key_binds_audio_permissions_to_user_room_and_expiry(config, monkeypatch):
    monkeypatch.setattr(time, "time", lambda: NOW)
    config = replace(config, room_auth_enabled=True)
    result = TencentRtcProvider(config).create_join_params(USER_ID, ROOM_ID, call_id=CALL_ID)
    signature = decode_signature(result["private_map_key"], config.sdk_secret_key)
    assert signature["TLS.identifier"] == USER_ID
    assert signature["TLS.sdkappid"] == config.sdk_app_id
    assert signature["TLS.expire"] == config.user_sig_ttl_seconds
    userbuf = base64.b64decode(signature["TLS.userbuf"])
    version, size = struct.unpack(">BH", userbuf[:3])
    assert version == 0
    assert userbuf[3:3 + size].decode() == USER_ID
    app_id, room_id, expires_at, privileges, account_type = struct.unpack(">IIIII", userbuf[3 + size:])
    assert (app_id, room_id, expires_at, privileges, account_type) == (
        config.sdk_app_id, ROOM_ID, NOW + config.user_sig_ttl_seconds, 15, 0,
    )


def test_start_uses_call_json_with_semantic_nonstreaming_protocol_and_no_metadata(config, transport):
    welcome_message = "那条河边有什么让您记得很清楚的事？"
    assert transport.provider.start_conversation(
        call_id=CALL_ID, room_id=ROOM_ID, user_id=USER_ID, welcome_message=welcome_message,
    ) == "test-task"
    action, payload = transport.client.call_json.call_args.args
    assert action == "StartAIConversation"
    assert payload["SessionId"] == CALL_ID
    assert payload["RoomId"] == str(ROOM_ID) and payload["RoomIdType"] == 0
    agent = payload["AgentConfig"]
    assert agent["TargetUserId"] == USER_ID
    assert agent["TurnDetectionMode"] == 3
    assert agent["TurnDetection"] == {"SemanticEagerness": "low"}
    assert agent["InterruptMode"] == 1
    assert agent["WelcomeMessage"] == welcome_message
    assert agent["SubtitleMode"] == 1
    join = transport.provider.create_join_params(USER_ID, ROOM_ID, call_id=CALL_ID)
    assert agent["UserId"] == join["bot_user_id"]
    assert decode_signature(agent["UserSig"], config.sdk_secret_key)["TLS.identifier"] == agent["UserId"]
    llm = json.loads(payload["LLMConfig"])
    assert llm["APIUrl"] == config.llm_api_url and llm["APIKey"] == config.llm_api_key
    assert llm["History"] == 0 and llm["Streaming"] is False
    assert "MetaInfo" not in llm
    transport.client.call_json.assert_called_once()


def test_describe_supports_task_id_and_original_call_id(transport, config):
    remote = {"TaskId": "test-task", "Status": "InProgress"}
    transport.client.call_json.return_value = {"Response": remote}
    assert transport.provider.describe_conversation(task_id="test-task") == remote
    assert transport.provider.describe_conversation(call_id=CALL_ID) == remote
    assert [call.args for call in transport.client.call_json.call_args_list] == [
        ("DescribeAIConversation", {"SdkAppId": config.sdk_app_id, "TaskId": "test-task"}),
        ("DescribeAIConversation", {"SdkAppId": config.sdk_app_id, "SessionId": CALL_ID}),
    ]


@pytest.mark.parametrize("options", [{}, {"task_id": "test-task", "call_id": CALL_ID}])
def test_describe_requires_exactly_one_identifier(transport, options):
    with pytest.raises(TencentRtcError) as invalid:
        transport.provider.describe_conversation(**options)
    assert invalid.value.code == "RTC_INVALID_REQUEST"
    transport.client.call_json.assert_not_called()


@pytest.mark.parametrize("operation", ["describe", "stop"])
def test_missing_cloud_task_is_idempotent(transport, operation):
    transport.client.call_json.side_effect = TencentCloudSDKException("FailedOperation.TaskNotExist", "private text")
    method = transport.provider.describe_conversation if operation == "describe" else transport.provider.stop_conversation
    assert method(task_id="missing-task") is None
    assert method(task_id="missing-task") is None
    assert transport.client.call_json.call_count == 2


@pytest.mark.parametrize("failure,code", [
    (TencentCloudSDKException("InvalidParameter", "private-sdk-detail", "private-request-id"), "RTC_PROVIDER_FAILED"),
    (TencentCloudSDKException("AuthFailure.SignatureFailure", "private-sdk-detail"), "RTC_PROVIDER_FAILED"),
    (TencentCloudSDKException("ServerNetworkError", "private-sdk-detail"), "RTC_PROVIDER_UNCERTAIN"),
    (TencentCloudSDKException("FailedOperation.TaskExist", "private-sdk-detail"), "RTC_PROVIDER_UNCERTAIN"),
    (TencentCloudSDKException(["InvalidParameter"], "private-sdk-detail"), "RTC_PROVIDER_UNCERTAIN"),
    (Timeout("private-sdk-detail"), "RTC_PROVIDER_UNCERTAIN"),
])
def test_sdk_failures_are_classified_without_exposing_raw_details(transport, config, failure, code, caplog):
    transport.client.call_json.side_effect = failure
    with pytest.raises(TencentRtcError) as caught:
        start(transport.provider)
    assert caught.value.code == code
    assert not hasattr(caught.value, "provider_code")
    assert not hasattr(caught.value, "request_id")
    assert not hasattr(caught.value, "action")
    output = str(caught.value) + repr(caught.value) + caplog.text
    for secret in ("private-sdk-detail", "private-request-id", config.secret_key, config.llm_api_key):
        assert secret not in output
    transport.client.call_json.assert_called_once()


@pytest.mark.parametrize("response", [{"Response": {}}, {"Response": []}])
def test_malformed_start_response_is_uncertain(transport, response):
    transport.client.call_json.return_value = response
    with pytest.raises(TencentRtcError) as caught:
        start(transport.provider)
    assert caught.value.code == "RTC_PROVIDER_UNCERTAIN"


def test_llm_headers_are_case_insensitive_and_preserve_request_identity(config):
    headers = {key.swapcase(): value for key, value in llm_headers(config).items()}
    assert TencentRtcProvider(config).verify_llm_request(headers) == {
        "sdk_app_id": str(config.sdk_app_id), "task_id": "test-task", "request_id": "voice-request",
        "user_id": USER_ID, "room_id": str(ROOM_ID), "room_id_type": "0",
    }


@pytest.mark.parametrize("tamper", ["token", "app", "missing-request", "duplicate-auth", "duplicate-request"])
def test_llm_rejects_tampering_missing_identity_and_duplicate_headers(config, tamper):
    headers = llm_headers(config)
    if tamper == "token":
        headers["Authorization"] = "Bearer forged"
    elif tamper == "app":
        headers["X-Sdk-App-Id"] = "1400000002"
    elif tamper == "missing-request":
        del headers["X-Request-Id"]
    else:
        headers = duplicate_header(headers, "Authorization" if tamper == "duplicate-auth" else "X-Request-Id")
    with pytest.raises(TencentRtcError) as caught:
        TencentRtcProvider(config).verify_llm_request(headers)
    assert caught.value.code == "RTC_UNAUTHORIZED"


def test_event_signature_uses_original_bytes_and_case_insensitive_headers(config):
    body = b' { "EventType": 903 }\n'
    headers = {key.swapcase(): value for key, value in event_headers(config, body).items()}
    assert TencentRtcProvider(config).verify_callback(body, headers) is None


@pytest.mark.parametrize("tamper", ["body", "signature", "app", "duplicate-sign"])
def test_event_signature_rejects_tampering_and_duplicates(config, tamper):
    body = b'{"EventType":903}'
    headers = event_headers(config, body)
    if tamper == "body":
        body += b" "
    elif tamper == "signature":
        headers["Sign"] = "forged"
    elif tamper == "app":
        headers["SdkAppId"] = "1400000002"
    else:
        headers = duplicate_header(headers, "Sign")
    with pytest.raises(TencentRtcError) as caught:
        TencentRtcProvider(config).verify_callback(body, headers)
    assert caught.value.code == "RTC_UNAUTHORIZED"


def test_slow_start_does_not_block_other_thread_stop_and_clients_are_reused_per_thread(config):
    entered, release, stopped = Event(), Event(), Event()
    clients, lock = [], Lock()

    class Client:
        def call_json(self, action, payload):
            if action == "StartAIConversation":
                entered.set()
                assert release.wait(timeout=5)
                return {"Response": {"TaskId": "test-task"}}
            if action == "StopAIConversation":
                stopped.set()
                return {"Response": {"RequestId": "stop-request"}}
            return {"Response": {"TaskId": "test-task", "Status": "InProgress"}}

    def factory():
        client = Client()
        with lock:
            clients.append(client)
        return client

    provider = TencentRtcProvider(config, client_factory=factory)

    def start_and_describe():
        task_id = start(provider)
        return provider.describe_conversation(task_id=task_id)

    with ThreadPoolExecutor(max_workers=2) as pool:
        starting = pool.submit(start_and_describe)
        try:
            assert entered.wait(timeout=5)
            stopping = pool.submit(provider.stop_conversation, "other-task")
            assert stopped.wait(timeout=1)
            assert stopping.result(timeout=1) is None
        finally:
            release.set()
        assert starting.result(timeout=5)["Status"] == "InProgress"
    assert len(clients) == 2 and clients[0] is not clients[1]


def test_default_sdk_disables_retry_and_does_not_log_payload_secrets(config, monkeypatch, caplog):
    profiles = []

    def call_json(client, action, payload):
        profiles.append(client.profile)
        logging.getLogger("tencentcloud_sdk_common").debug("SDK request %s", payload)
        return {"Response": {"TaskId": "test-task"}}

    monkeypatch.setattr(TrtcClient, "call_json", call_json)
    with caplog.at_level(logging.DEBUG, logger="tencentcloud_sdk_common"):
        assert start(TencentRtcProvider(config)) == "test-task"
    assert len(profiles) == 1
    assert isinstance(profiles[0].retryer, NoopRetryer)
    assert profiles[0].httpProfile.reqTimeout == config.request_timeout_seconds
    assert profiles[0].httpProfile.endpoint == "trtc.tencentcloudapi.com"
    for secret in (config.secret_id, config.secret_key, config.sdk_secret_key, config.llm_api_key):
        assert secret not in caplog.text

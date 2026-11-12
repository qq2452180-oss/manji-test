"""腾讯 AI 事件入口验签与无业务副作用验证；不连接网络或数据库。"""

import base64
from copy import deepcopy
import hashlib
import hmac
import json
import logging
import socket
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from src.api.rtc.router import MAX_EVENT_BODY_BYTES, router
from src.common.tencent_rtc import TencentRtcConfig, TencentRtcProvider
from src.service.rtc import DirectRtcService


PATH = "/api/rtc/events"


@pytest.fixture
def events(monkeypatch):
    forbidden = Mock(side_effect=AssertionError("事件测试不可连接网络或数据库"))
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr("psycopg.connect", forbidden)
    config = TencentRtcConfig(
        sdk_app_id=1400000001, secret_id="test-cloud-id", secret_key="test-cloud-key",
        sdk_secret_key="test-sdk-key", llm_api_url="https://test.invalid/api/rtc/llm/chat/completions",
        llm_api_key="test-bridge-key", llm_model="interview", voice_id="test-voice",
        callback_key="testEventCallbackKey",
    )
    provider = TencentRtcProvider(config)
    provider._call = Mock(side_effect=AssertionError("events must not call Tencent"))
    interview, auth = Mock(), Mock()
    service = DirectRtcService(provider, interview)
    app = FastAPI()
    app.include_router(router)
    app.state.rtc = service
    app.state.auth = auth
    payload = {
        "EventGroupId": 9, "EventType": 903, "CallbackTs": 12345,
        "EventInfo": {"TaskId": "unknown-task-private", "EventMsTs": 12344,
                      "RoomId": "42", "RoomIdType": 0,
                      "Payload": {"Text": "不应进入日志的用户原话", "UserId": "private-user"}},
    }
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, app=app, config=config, payload=payload,
                              provider=provider, service=service)
    assert interview.mock_calls == []
    assert auth.mock_calls == []
    provider._call.assert_not_called()
    forbidden.assert_not_called()


def signed_headers(events, raw):
    signature = base64.b64encode(hmac.new(
        events.config.callback_key.encode(), raw, hashlib.sha256,
    ).digest()).decode()
    return {"SdkAppId": str(events.config.sdk_app_id), "Sign": signature,
            "Content-Type": "application/json"}


def encode(payload):
    return json.dumps(payload, ensure_ascii=False, indent=2).encode() + b"\n"


def test_signed_raw_bytes_and_duplicate_unknown_tasks_are_acknowledged_without_business_work(events, caplog):
    raw = encode(events.payload)
    headers = {key.swapcase(): value for key, value in signed_headers(events, raw).items()}
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        for _ in range(2):
            response = events.client.post(PATH, content=raw, headers=headers)
            assert response.status_code == 200
            assert response.json() == {"code": 0}
            assert response.headers["cache-control"] == "private, no-store"
    assert caplog.text.count("RTC event accepted event_type=903") == 2
    for value in ("不应进入日志的用户原话", "unknown-task-private", "private-user",
                  events.config.callback_key, headers["sIGN"]):
        assert value not in caplog.text


@pytest.mark.parametrize("tamper", ["missing", "body", "sign", "sdk_app_id"])
def test_event_authentication_rejects_missing_forged_or_changed_requests(events, tamper, caplog):
    raw = encode(events.payload)
    headers = signed_headers(events, raw)
    if tamper == "missing":
        headers = {}
    elif tamper == "body":
        raw += b" "
    elif tamper == "sign":
        headers["Sign"] = "forged-signature"
    else:
        headers["SdkAppId"] = "1400000002"
    response = events.client.post(PATH, content=raw, headers=headers)
    assert response.status_code == 401
    assert response.json()["code"] == "RTC_EVENT_UNAUTHORIZED"
    assert "不应进入日志" not in response.text + caplog.text
    assert "RTC event accepted" not in caplog.text


@pytest.mark.parametrize("change", [
    "array", "group", "type_string", "type_bool", "type_negative", "type_large", "info", "task",
])
def test_signed_malformed_events_are_rejected_without_logging_contents(events, change, caplog):
    payload = deepcopy(events.payload)
    if change == "array":
        payload = [payload]
    elif change == "group":
        payload["EventGroupId"] = 4
    elif change.startswith("type_"):
        payload["EventType"] = {"type_string": "903\nprivate", "type_bool": True,
                                "type_negative": -1, "type_large": 65536}[change]
    elif change == "info":
        payload["EventInfo"] = []
    else:
        payload["EventInfo"]["TaskId"] = ""
    raw = encode(payload)
    response = events.client.post(PATH, content=raw, headers=signed_headers(events, raw))
    assert response.status_code == 422
    assert response.json()["code"] == "RTC_INVALID_EVENT"
    assert "private" not in response.text + caplog.text
    assert "不应进入日志" not in response.text + caplog.text


def test_event_body_limit_and_invalid_json_use_safe_errors(events):
    oversized = b"x" * (MAX_EVENT_BODY_BYTES + 1)
    response = events.client.post(PATH, content=iter([oversized[:100], oversized[100:]]),
                                  headers=signed_headers(events, oversized))
    assert response.status_code == 413
    assert response.json()["code"] == "RTC_REQUEST_TOO_LARGE"
    raw = b'{"private-body":'
    response = events.client.post(PATH, content=raw, headers=signed_headers(events, raw))
    assert response.status_code == 422
    assert "private-body" not in response.text


def test_event_requires_enabled_rtc_but_not_browser_login(events):
    events.app.state.rtc = None
    raw = encode(events.payload)
    response = events.client.post(PATH, content=raw, headers=signed_headers(events, raw))
    assert response.status_code == 503
    assert response.json()["code"] == "RTC_UNAVAILABLE"


def test_future_event_type_in_ai_group_is_acknowledged(events):
    events.payload["EventType"] = 999
    raw = encode(events.payload)
    response = events.client.post(PATH, content=raw, headers=signed_headers(events, raw))
    assert response.status_code == 200
    assert response.json() == {"code": 0}

"""RTC 本地代理的原始请求透传与入口限制；上游全部离线模拟。"""

import base64
import hashlib
import hmac
from types import SimpleNamespace

import httpx
import pytest
from starlette.testclient import TestClient

from src.common.tencent_rtc import TencentRtcConfig, TencentRtcProvider
from src.tools import rtc_callback_proxy as proxy


@pytest.fixture
def forwarded(monkeypatch):
    state = SimpleNamespace(requests=[], response=httpx.Response(200, content=b'{"ok":true}'), options=None)
    original_client = httpx.AsyncClient

    def upstream(request):
        state.requests.append(request)
        if isinstance(state.response, Exception):
            raise state.response
        return state.response

    def client_factory(**options):
        state.options = options
        return original_client(transport=httpx.MockTransport(upstream), **options)

    monkeypatch.setattr(proxy.httpx, "AsyncClient", client_factory)
    with TestClient(proxy.app) as client:
        state.client = client
        yield state


@pytest.fixture
def provider():
    return TencentRtcProvider(TencentRtcConfig(
        sdk_app_id=1400000000, secret_id="test-id", secret_key="test-key",
        sdk_secret_key="test-sdk-key", llm_api_url="https://test.invalid/api/rtc/llm/chat/completions",
        llm_api_key="test-bridge-token", llm_model="interview", voice_id="test-voice",
        callback_key="testCallbackKey",
    ))


@pytest.mark.parametrize("path", proxy.PATHS)
@pytest.mark.parametrize("port", [8003, 8004])
def test_post_preserves_raw_body_and_provider_authentication_headers(forwarded, provider, path, port, monkeypatch):
    monkeypatch.setattr(proxy, "BACKEND_PORT", port)
    raw = ' { "messages": [{"role": "user", "content": "树下乘凉"}] }\n'.encode()
    if path.endswith("/events"):
        signature = base64.b64encode(hmac.new(
            provider.config.callback_key.encode(), raw, hashlib.sha256,
        ).digest()).decode()
        headers = {"sIgN": signature, "SdKaPpId": str(provider.config.sdk_app_id)}
    else:
        headers = {
            "aUtHoRiZaTiOn": "Bearer test-bridge-token",
            "X-Sdk-App-Id": str(provider.config.sdk_app_id), "X-Task-Id": "test-task",
            "X-Request-Id": "test-request", "X-User-Id": "test-user",
            "X-Room-Id": "123", "X-Room-Id-Type": "0", "X-Invoke-LLM": "true",
        }
    headers.update({"Content-Type": "application/json", "X-Unrelated": "not-forwarded", "Cookie": "private"})
    expected_body = b'{"detail":"upstream validation"}'
    forwarded.response = httpx.Response(422, content=expected_body, headers={"Content-Type": "application/json"})

    response = forwarded.client.post(path, content=raw, headers=headers)

    assert response.status_code == 422
    assert response.content == expected_body
    assert response.headers["cache-control"] == "private, no-store"
    assert len(forwarded.requests) == 1
    request = forwarded.requests[0]
    assert request.method == "POST" and str(request.url) == f"http://127.0.0.1:{port}" + path
    assert request.content == raw
    assert "x-unrelated" not in request.headers and "cookie" not in request.headers
    assert request.headers["content-type"] == "application/json"
    if path.endswith("/events"):
        provider.verify_callback(request.content, request.headers)
    else:
        assert provider.verify_llm_request(request.headers) == {
            "task_id": "test-task", "request_id": "test-request", "sdk_app_id": "1400000000",
            "user_id": "test-user", "room_id": "123", "room_id_type": "0",
        }
        assert request.headers["x-invoke-llm"] == "true"
    assert forwarded.options["follow_redirects"] is False
    assert forwarded.options["trust_env"] is False


@pytest.mark.parametrize("path", [
    "/", "/api/interviews", "/api/rtc/events/", "/api/rtc/llm/chat/completions/",
    "/api/rtc/events?debug=1", "/api/rtc/%65vents",
])
def test_other_paths_query_strings_and_encoded_aliases_are_not_forwarded(forwarded, path):
    assert forwarded.client.post(path, content=b"{}").status_code == 404
    assert forwarded.requests == []


def test_get_on_callback_route_is_not_forwarded(forwarded):
    assert forwarded.client.get(proxy.PATHS[0]).status_code == 405
    assert forwarded.requests == []


@pytest.mark.parametrize("declared_size", [None, "1", str(proxy.MAX_BODY_BYTES + 1)])
def test_body_limit_checks_actual_bytes_as_well_as_content_length(forwarded, declared_size):
    headers = {"Content-Length": declared_size} if declared_size is not None else {}
    response = forwarded.client.post(proxy.PATHS[0], content=b"x" * (proxy.MAX_BODY_BYTES + 1), headers=headers)
    assert response.status_code == 413
    assert response.json()["code"] == "RTC_REQUEST_TOO_LARGE"
    assert forwarded.requests == []


def test_exact_body_limit_is_forwarded(forwarded):
    raw = b"x" * proxy.MAX_BODY_BYTES
    assert forwarded.client.post(proxy.PATHS[1], content=raw).status_code == 200
    assert forwarded.requests[0].content == raw


def test_compressed_body_is_rejected_without_forwarding(forwarded):
    response = forwarded.client.post(proxy.PATHS[1], content=b"compressed", headers={"Content-Encoding": "gzip"})
    assert response.status_code == 415
    assert forwarded.requests == []


@pytest.mark.parametrize("status", [301, 307, 308])
def test_upstream_redirects_are_not_followed_or_exposed(forwarded, status):
    forwarded.response = httpx.Response(status, headers={"Location": "https://unexpected.invalid/"})
    response = forwarded.client.post(proxy.PATHS[0], content=b"{}")
    assert response.status_code == 502
    assert response.json()["code"] == "RTC_PROXY_UPSTREAM_REDIRECT"
    assert "location" not in response.headers
    assert len(forwarded.requests) == 1


@pytest.mark.parametrize("exception,status,code", [
    (httpx.ReadTimeout("offline timeout"), 504, "RTC_PROXY_UPSTREAM_TIMEOUT"),
    (httpx.ConnectError("offline unavailable"), 502, "RTC_PROXY_UPSTREAM_UNAVAILABLE"),
])
def test_upstream_failures_return_stable_errors(forwarded, exception, status, code):
    forwarded.response = exception
    response = forwarded.client.post(proxy.PATHS[0], content=b"{}")
    assert response.status_code == status
    assert response.json() == {"code": code}
    assert len(forwarded.requests) == 1

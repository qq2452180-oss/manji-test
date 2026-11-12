"""正式账号准入后，旧游客仍可安全挂断自己的在途通话；全程离线。"""

import socket
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from src.api.rtc.router import router
from src.service.auth import AuthService
from src.service.rtc import DirectRtcService
from src.tests.test_guest_auth import MemoryAuthRepository, bearer


@pytest.fixture
def legacy_guest_call(monkeypatch):
    forbidden = Mock(side_effect=AssertionError("通话准入测试不可连接网络或数据库"))
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr("psycopg.connect", forbidden)

    auth = AuthService(MemoryAuthRepository())
    owner, outsider = auth.start_guest(), auth.start_guest()
    owner_id = owner["user"]["id"]
    provider = Mock()
    provider.config = SimpleNamespace(sdk_app_id=1400000001)
    provider.create_join_params.return_value = {}
    provider.start_conversation.return_value = "legacy-task"
    provider.describe_conversation.return_value = {"TaskId": "legacy-task", "Status": "InProgress"}
    interview = Mock()
    interview.get_session.return_value = {
        "messages": [{"role": "assistant", "content": "我们聊聊您的故事。"}],
    }
    service = DirectRtcService(provider, interview)

    # 准备停用游客入口之前已经存在的通话，不经过当前成员准入接口。
    call = service.prepare(owner_id, "7", "legacy-call")
    assert service.start(owner_id, call["call_id"])["status"] == "ACTIVE"
    provider.reset_mock()
    interview.reset_mock()

    app = FastAPI()
    app.state.auth = auth
    app.state.rtc = service
    app.include_router(router)
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client, owner=owner, outsider=outsider,
            service=service, interview=interview, provider=provider, call_id=call["call_id"],
        )
    forbidden.assert_not_called()


def test_old_guest_can_only_stop_their_own_active_call(legacy_guest_call):
    rtc = legacy_guest_call
    call_path = f"/api/rtc/calls/{rtc.call_id}"
    owner_headers = bearer(rtc.owner["token"])
    owner_id = rtc.owner["user"]["id"]

    anonymous = rtc.client.post(call_path + "/stop")
    assert anonymous.status_code == 401
    assert anonymous.headers["cache-control"] == "private, no-store"
    foreign = rtc.client.post(call_path + "/stop", headers=bearer(rtc.outsider["token"]))
    assert foreign.status_code == 404
    assert foreign.json()["code"] == "RTC_CALL_NOT_FOUND"

    for method, path, options in (
        ("POST", "/api/interviews/7/calls", {"json": {"client_request_id": "new-call"}}),
        ("POST", call_path + "/start", {}),
        ("GET", call_path, {}),
    ):
        response = rtc.client.request(method, path, headers=owner_headers, **options)
        assert response.status_code == 403
        assert response.headers["cache-control"] == "private, no-store"

    assert rtc.provider.mock_calls == []
    assert rtc.interview.mock_calls == []

    stopped = rtc.client.post(call_path + "/stop", headers=owner_headers)
    assert stopped.status_code == 200
    assert stopped.json()["status"] == "STOPPED"
    assert stopped.json()["call_id"] == rtc.call_id
    assert rtc.service.get(owner_id, rtc.call_id)["status"] == "STOPPED"
    rtc.provider.stop_conversation.assert_called_once_with("legacy-task")

    repeated = rtc.client.post(call_path + "/stop", headers=owner_headers)
    assert repeated.status_code == 200
    assert repeated.json()["status"] == "STOPPED"
    rtc.provider.stop_conversation.assert_called_once_with("legacy-task")
    rtc.provider.create_join_params.assert_not_called()
    rtc.provider.start_conversation.assert_not_called()
    rtc.provider.describe_conversation.assert_not_called()

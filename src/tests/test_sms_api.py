"""通过真实的内存验证码服务验证两个 HTTP 接口。发送器和账号数据库使用替身。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import re
from threading import Event
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from src.api.auth.router import router
from src.common.tencent_sms import SmsDeliveryError, TencentSmsSender
from src.service.auth import AuthRepository, AuthService
from src.service.auth.sms import SmsAuthService
from src.service.auth.sms_codes import SmsCodeStore


PHONE = "13900000001"
NORMALIZED_PHONE = "+86" + PHONE
SEND = "/api/auth/sms/send"
LOGIN = "/api/auth/sms/login"


@pytest.fixture
def sms():
    repository = Mock(spec=AuthRepository)
    repository.login_with_verified_phone.return_value = {
        "id": 31, "username": "internal-account", "create_time": datetime.now(timezone.utc),
    }
    sender = Mock(spec=TencentSmsSender)
    app = FastAPI()
    app.state.sms_auth = SmsAuthService(repository, sender)
    app.state.auth = AuthService(repository)
    app.include_router(router)
    with TestClient(app) as client:
        yield client, repository, sender


def issue_code(client, sender):
    assert client.post(SEND, json={"phone": PHONE}).status_code == 200
    return {"phone": NORMALIZED_PHONE, "code": sender.send_code.call_args.args[1]}


def test_send_and_login_return_a_session_accepted_by_me(sms, monkeypatch):
    client, repository, sender = sms
    monkeypatch.setattr("src.service.auth.sms.secrets.randbelow", lambda upper_bound: 42)
    sent = client.post(SEND, json={"phone": PHONE})
    assert sent.status_code == 200
    assert sent.json() == {"expires_in": 300, "retry_after": 60}
    assert sent.headers["cache-control"] == "private, no-store"
    sender.send_code.assert_called_once_with(NORMALIZED_PHONE, "000042", valid_minutes=5)
    assert "000042" not in sent.text
    assert repository.mock_calls == []

    login = {"phone": NORMALIZED_PHONE, "code": "000042"}
    assert client.post(LOGIN, json={**login, "code": "000041"}).status_code == 400
    assert repository.mock_calls == []
    result = client.post(LOGIN, json=login)
    assert result.status_code == 200
    assert result.headers["cache-control"] == "private, no-store"
    body = result.json()
    assert set(body) == {"token", "user"}
    assert set(body["user"]) == {"id", "username", "create_time"}
    assert body["user"]["id"] == 31
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", body["token"])
    token_hash = hashlib.sha256(body["token"].encode("ascii")).hexdigest()
    phone, username, password_hash, saved_hash = repository.login_with_verified_phone.call_args.args
    assert phone == NORMALIZED_PHONE and re.fullmatch(r"sms:[0-9a-f]{32}", username)
    assert password_hash.startswith("$argon2id$") and saved_hash == token_hash

    assert client.post(LOGIN, json=login).status_code == 400
    repository.login_with_verified_phone.assert_called_once()
    repository.find_user_by_token.return_value = {"id": 31, "is_guest": False}
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
    assert me.json() == {"user_id": 31, "is_guest": False}
    repository.find_user_by_token.assert_called_once_with(token_hash)


@pytest.mark.parametrize(("path", "body"), [
    (SEND, {"phone": "private-invalid-phone"}),
    (SEND, {}),
    (LOGIN, {"phone": PHONE, "code": "secret-input"}),
    (LOGIN, {"phone": PHONE, "code": "１１１１１１"}),
    (LOGIN, {"phone": PHONE, "code": 123456}),
])
def test_rejects_bad_inputs_without_echoing_them(sms, path, body):
    client, repository, sender = sms
    response = client.post(path, json=body)
    assert response.status_code == 422
    assert set(response.json()) == {"detail"}
    assert all(str(value) not in response.text for value in body.values())
    assert response.headers["cache-control"] == "private, no-store"
    sender.send_code.assert_not_called()
    assert repository.mock_calls == []


def test_resend_cooldown_prevents_another_delivery(sms):
    client, repository, sender = sms
    issue_code(client, sender)
    assert client.post(SEND, json={"phone": NORMALIZED_PHONE}).status_code == 429
    sender.send_code.assert_called_once()
    assert repository.mock_calls == []


def test_provider_error_leaves_code_unusable(sms):
    client, repository, sender = sms
    sender.send_code.side_effect = SmsDeliveryError("private provider detail")
    response = client.post(SEND, json={"phone": PHONE})
    assert response.status_code == 503
    assert "private provider detail" not in response.text and PHONE not in response.text
    phone, code = sender.send_code.call_args.args
    assert client.post(LOGIN, json={"phone": phone, "code": code}).status_code == 400
    assert repository.mock_calls == []


def test_expired_send_cannot_activate_a_code(sms):
    client, repository, sender = sms
    clock = Mock(return_value=0)
    client.app.state.sms_auth = SmsAuthService(repository, sender, codes=SmsCodeStore(clock=clock))

    def delayed_send(phone, code, *, valid_minutes):
        clock.return_value = 301

    sender.send_code.side_effect = delayed_send
    assert client.post(SEND, json={"phone": PHONE}).status_code == 409
    phone, code = sender.send_code.call_args.args
    assert client.post(LOGIN, json={"phone": phone, "code": code}).status_code == 400
    assert repository.mock_calls == []


def test_code_can_be_retried_after_a_rolled_back_account_write(sms):
    client, repository, sender = sms
    body = issue_code(client, sender)
    write = repository.login_with_verified_phone
    write.side_effect = [psycopg.errors.SerializationFailure("private database detail"), write.return_value]
    response = client.post(LOGIN, json=body)
    assert response.status_code == 503
    assert "private database detail" not in response.text
    assert client.post(LOGIN, json=body).status_code == 200
    assert client.post(LOGIN, json=body).status_code == 400
    assert write.call_count == 2


def test_unknown_commit_outcome_keeps_code_spent(sms):
    client, repository, sender = sms
    body = issue_code(client, sender)
    write = repository.login_with_verified_phone
    write.side_effect = psycopg.OperationalError("connection lost during commit")
    response = client.post(LOGIN, json=body)
    assert response.status_code == 503
    assert "during commit" not in response.text
    assert client.post(LOGIN, json=body).status_code == 400
    write.assert_called_once()


def test_two_concurrent_logins_use_the_code_only_once(sms):
    client, repository, sender = sms
    body = issue_code(client, sender)
    entered, release = Event(), Event()
    write = repository.login_with_verified_phone

    def save(*args):
        entered.set()
        assert release.wait(5)
        return write.return_value

    write.side_effect = save
    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(client.post, LOGIN, json=body)
        try:
            assert entered.wait(5)
            assert client.post(LOGIN, json=body).status_code == 400
        finally:
            release.set()
        assert first.result(timeout=5).status_code == 200
    write.assert_called_once()


def test_new_service_has_no_codes_from_an_earlier_process(sms):
    client, repository, sender = sms
    body = issue_code(client, sender)
    client.app.state.sms_auth = SmsAuthService(repository, sender)
    assert client.post(LOGIN, json=body).status_code == 400
    assert repository.mock_calls == []


def test_unconfigured_sender_returns_service_unavailable(sms):
    client, repository, _ = sms
    client.app.state.sms_auth = SmsAuthService(repository, None)
    assert client.post(SEND, json={"phone": PHONE}).status_code == 503
    response = client.post(LOGIN, json={"phone": PHONE, "code": "000001"})
    assert response.status_code == 400
    assert PHONE not in response.text and "000001" not in response.text
    assert repository.mock_calls == []

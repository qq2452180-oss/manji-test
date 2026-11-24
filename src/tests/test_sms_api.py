"""通过真实的内存验证码服务验证短信和图片验证接口。发送器和账号数据库使用替身。"""

import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import re
import secrets
from threading import Event
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
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
CAPTCHA = "/api/auth/sms/captcha"
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


@pytest.fixture
def timed_sms(sms, monkeypatch):
    client, repository, sender = sms
    clock = Mock(return_value=0)
    client.app.state.sms_auth = SmsAuthService(repository, sender, codes=SmsCodeStore(clock))
    real_randbelow = secrets.randbelow
    monkeypatch.setattr(secrets, "randbelow", lambda n: 42 if n == 10_000 else real_randbelow(n))
    return client, sender, clock


def challenge_from(response, code):
    assert 400 <= response.status_code < 500
    assert response.headers["cache-control"] == "private, no-store"
    body = response.json()
    assert body["code"] == code
    captcha = body["captcha"]
    assert set(captcha) == {"id", "image"} and captcha["id"]
    assert captcha["image"].startswith("data:image/png;base64,")
    return captcha


def answer_challenge(client, captcha, answer="0042", phone=PHONE):
    return client.post(SEND, json={"phone": phone, "captcha": {"id": captcha["id"], "answer": answer}})


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
    clock = Mock(return_value=0)
    client.app.state.sms_auth = SmsAuthService(repository, sender, codes=SmsCodeStore(clock))
    issue_code(client, sender)
    clock.return_value = 17.4
    response = client.post(SEND, json={"phone": NORMALIZED_PHONE})
    assert response.status_code == 429
    assert response.json() == {"detail": "验证码请求过于频繁，请稍后再试", "code": "SMS_COOLDOWN", "retry_after": 43}
    assert response.headers["retry-after"] == "43"
    sender.send_code.assert_called_once()
    assert repository.mock_calls == []
    clock.return_value = 60
    assert client.post(SEND, json={"phone": PHONE}).status_code == 200


def test_third_and_following_sends_require_an_image_after_cooldown(timed_sms):
    client, sender, clock = timed_sms
    issue_code(client, sender)
    clock.return_value = 60
    second_sms = issue_code(client, sender)
    clock.return_value = 119.5
    for path in (SEND, CAPTCHA):
        wait = client.post(path, json={"phone": NORMALIZED_PHONE})
        assert wait.status_code == 429 and wait.json()["code"] == "SMS_COOLDOWN"
        assert wait.json()["retry_after"] == 1 and "captcha" not in wait.json()

    clock.return_value = 120
    challenge = challenge_from(client.post(SEND, json={"phone": NORMALIZED_PHONE}), "SMS_CAPTCHA_REQUIRED")
    encoded = challenge["image"].removeprefix("data:image/png;base64,")
    with Image.open(BytesIO(base64.b64decode(encoded, validate=True))) as image:
        assert image.format == "PNG" and image.width > image.height
        image.load()
        assert any(low < high for low, high in image.convert("RGB").getextrema())
    wrong = challenge_from(answer_challenge(client, challenge, "9999"), "SMS_CAPTCHA_INVALID")
    assert wrong["id"] != challenge["id"]
    replacement = client.post(CAPTCHA, json={"phone": PHONE})
    assert replacement.status_code == 200 and replacement.headers["cache-control"] == "private, no-store"
    fresh = replacement.json()
    assert set(fresh) == {"id", "image"} and fresh["id"] != wrong["id"]
    assert sender.send_code.call_count == 2
    assert client.post(LOGIN, json=second_sms).status_code == 200

    outdated = challenge_from(answer_challenge(client, wrong), "SMS_CAPTCHA_INVALID")
    assert answer_challenge(client, outdated).json() == {"expires_in": 300, "retry_after": 60}
    assert sender.send_code.call_count == 3
    clock.return_value = 180
    fourth = challenge_from(client.post(SEND, json={"phone": PHONE}), "SMS_CAPTCHA_REQUIRED")
    assert fourth["id"] != outdated["id"]
    assert answer_challenge(client, fourth).status_code == 200
    assert sender.send_code.call_count == 4


def test_captcha_window_rolls_off_at_ten_minutes_from_each_send(timed_sms):
    client, sender, clock = timed_sms
    assert client.post(CAPTCHA, json={"phone": PHONE}).json()["code"] == "SMS_CAPTCHA_NOT_REQUIRED"
    assert sender.send_code.call_count == 0
    issue_code(client, sender)
    clock.return_value = 60
    issue_code(client, sender)
    clock.return_value = 599.9
    challenge_from(client.post(SEND, json={"phone": PHONE}), "SMS_CAPTCHA_REQUIRED")
    clock.return_value = 600
    resolved = client.post(CAPTCHA, json={"phone": PHONE})
    assert resolved.status_code == 409 and resolved.json()["code"] == "SMS_CAPTCHA_NOT_REQUIRED"
    assert sender.send_code.call_count == 2
    assert client.post(SEND, json={"phone": PHONE}).status_code == 200
    clock.return_value = 660
    assert client.post(SEND, json={"phone": PHONE}).status_code == 200
    clock.return_value = 720
    challenge_from(client.post(SEND, json={"phone": PHONE}), "SMS_CAPTCHA_REQUIRED")
    assert sender.send_code.call_count == 4


def test_images_are_bound_to_the_number_and_time_of_issue(timed_sms):
    client, sender, clock = timed_sms
    other_phone = "13900000002"
    for second in (0, 60):
        clock.return_value = second
        for phone in (PHONE, other_phone):
            assert client.post(SEND, json={"phone": phone}).status_code == 200
    clock.return_value = 120
    first = challenge_from(client.post(SEND, json={"phone": PHONE}), "SMS_CAPTCHA_REQUIRED")
    second = challenge_from(answer_challenge(client, first, phone=other_phone), "SMS_CAPTCHA_INVALID")
    assert second["id"] != first["id"]
    assert answer_challenge(client, second, phone=other_phone).status_code == 200
    clock.return_value = 420
    replacement = challenge_from(answer_challenge(client, first), "SMS_CAPTCHA_INVALID")
    assert answer_challenge(client, replacement).status_code == 200
    assert sender.send_code.call_count == 6


def test_window_counts_requests_accepted_even_if_delivery_fails(timed_sms):
    client, sender, clock = timed_sms
    sender.send_code.side_effect = SmsDeliveryError("private")
    assert client.post(SEND, json={"phone": PHONE}).status_code == 503
    clock.return_value = 60
    sender.send_code.side_effect = None
    issue_code(client, sender)
    clock.return_value = 120
    challenge_from(client.post(SEND, json={"phone": PHONE}), "SMS_CAPTCHA_REQUIRED")
    assert sender.send_code.call_count == 2


def test_provider_error_leaves_code_unusable(sms):
    client, repository, sender = sms
    clock = Mock(return_value=0)
    client.app.state.sms_auth = SmsAuthService(repository, sender, codes=SmsCodeStore(clock))

    def fail_delivery(*args, **kwargs):
        clock.return_value = 3.2
        raise SmsDeliveryError("private provider detail")

    sender.send_code.side_effect = fail_delivery
    response = client.post(SEND, json={"phone": PHONE})
    assert response.status_code == 503
    assert response.json() == {
        "detail": "验证码发送失败，请稍后再试", "code": "SMS_DELIVERY_FAILED",
        "rate_limit_code": "SMS_COOLDOWN", "retry_after": 57,
    }
    assert response.headers["retry-after"] == "57"
    assert "private provider detail" not in response.text and PHONE not in response.text
    phone, code = sender.send_code.call_args.args
    assert client.post(LOGIN, json={"phone": phone, "code": code}).status_code == 400
    assert repository.mock_calls == []


@pytest.mark.parametrize(("code", "limit"), [("SMS_PHONE_LIMIT", 10), ("SMS_IP_LIMIT", 30)])
@pytest.mark.parametrize("delivery_fails", [False, True])
def test_last_quota_slot_and_next_request_report_same_daily_limit(timed_sms, code, limit, delivery_fails):
    client, sender, clock = timed_sms
    for i in range(limit):
        phone = PHONE if code == "SMS_PHONE_LIMIT" else f"1390000{i:04d}"
        clock.return_value = i * 60
        if delivery_fails and i == limit - 1:
            sender.send_code.side_effect = SmsDeliveryError("private")
        response = client.post(SEND, json={"phone": phone})
        if code == "SMS_PHONE_LIMIT" and i >= 2:
            captcha = challenge_from(response, "SMS_CAPTCHA_REQUIRED")
            response = answer_challenge(client, captcha, phone=phone)
        if i < limit - 1:
            assert response.json() == {"expires_in": 300, "retry_after": 60}

    remaining = 86400 - clock.return_value
    assert response.status_code == (503 if delivery_fails else 200)
    assert response.json()["rate_limit_code"] == code
    assert response.json()["retry_after"] == remaining
    if delivery_fails:
        assert response.json()["code"] == "SMS_DELIVERY_FAILED"
        assert response.headers["retry-after"] == str(remaining)

    clock.return_value += 17.4
    for path in (SEND, CAPTCHA):
        rejected = client.post(path, json={"phone": phone})
        assert rejected.status_code == 429
        assert rejected.json()["code"] == code
        assert rejected.json()["retry_after"] == remaining - 17
        assert rejected.headers["retry-after"] == str(remaining - 17)
    assert sender.send_code.call_count == limit


@pytest.mark.parametrize("delivery_fails", [False, True])
def test_slow_delivery_reports_elapsed_cooldown(sms, delivery_fails):
    client, repository, sender = sms
    clock = Mock(return_value=0)
    client.app.state.sms_auth = SmsAuthService(repository, sender, codes=SmsCodeStore(clock))

    def delayed_delivery(*args, **kwargs):
        clock.return_value = 61
        if delivery_fails:
            raise SmsDeliveryError("private")

    sender.send_code.side_effect = delayed_delivery
    response = client.post(SEND, json={"phone": PHONE})
    assert response.status_code == (503 if delivery_fails else 200)
    assert response.json()["retry_after"] == 0
    assert "rate_limit_code" not in response.json()
    if delivery_fails:
        assert response.headers["retry-after"] == "0"


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

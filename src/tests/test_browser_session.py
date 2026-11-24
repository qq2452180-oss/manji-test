"""浏览器同源 cookie 会话、Bearer 兼容、撤销和固定期限的回归测试。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest.mock import Mock

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from src.api.auth.dependencies import get_current_user_id
from src.api.auth.router import router
from src.common.tencent_sms import TencentSmsSender
from src.service.auth import AuthRepository, AuthService
from src.service.auth.sms import SmsAuthService
from src.tests.test_guest_auth import MemoryAuthRepository, guest_database  # noqa: F401


ORIGIN = "https://manji.example"
BROWSER = {"X-Manji-Session": "cookie", "Origin": ORIGIN}
CREDENTIALS = {"username": "member", "password": "private-test-password"}


@pytest.fixture
def client():
    app = FastAPI()
    app.state.auth = AuthService(MemoryAuthRepository())
    app.include_router(router)

    @app.post("/write")
    def write(user_id: int = Depends(get_current_user_id)):
        return {"owner": user_id}

    with TestClient(app, base_url=ORIGIN) as browser:
        yield browser


def bound(session):
    return {**BROWSER, "X-Manji-Session-Id": session["session_id"]}


def test_browser_register_login_context_rotation_and_logout(client):
    registered = client.post("/api/auth/register", json=CREDENTIALS, headers=BROWSER)
    assert registered.status_code == 201
    first = registered.json()
    assert set(first) == {"user", "session_id"}
    cookie = registered.headers["set-cookie"]
    assert all(attr in cookie for attr in ("HttpOnly", "Max-Age=2592000", "Path=/", "SameSite=lax", "Secure"))
    first_token = client.cookies["manji_session"]
    assert first_token not in registered.text and first["session_id"] != first_token
    assert client.get("/api/auth/me", headers=BROWSER).json() == {
        "user_id": first["user"]["id"], "is_guest": False, "session_id": first["session_id"],
    }
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + first["session_id"]}).status_code == 401
    assert client.post("/write", headers=bound(first)).json() == {"owner": first["user"]["id"]}
    assert client.post("/write", headers=BROWSER).status_code == 409

    login = client.post("/api/auth/login", headers=bound(first), json=CREDENTIALS)
    assert login.status_code == 200
    second = login.json()
    assert set(second) == {"user", "session_id"} and second["session_id"] != first["session_id"]
    second_token = client.cookies["manji_session"]
    assert second_token != first_token
    old_bearer = {"Authorization": "Bearer " + first_token}
    assert client.get("/api/auth/me", headers=old_bearer).status_code == 401
    assert client.post("/api/auth/logout", headers=old_bearer).status_code == 204
    for path in ("/write", "/api/auth/logout"):
        stale = client.post(path, headers=bound(first))
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "AUTH_CONTEXT_CHANGED"
        assert "set-cookie" not in stale.headers
    assert client.post("/write", headers=bound(second)).status_code == 200
    off = client.post("/api/auth/logout", headers=bound(second))
    assert off.status_code == 204 and "Max-Age=0" in off.headers["set-cookie"]
    assert "manji_session" not in client.cookies
    assert client.post("/api/auth/logout", headers=bound(second)).status_code == 204
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + second_token}).status_code == 401


def test_only_opted_in_same_origin_requests_can_use_or_set_cookie(client):
    session = client.post("/api/auth/register", headers=BROWSER, json=CREDENTIALS).json()
    token = client.cookies["manji_session"]
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/write", headers={"Origin": ORIGIN}).status_code == 401
    assert "set-cookie" not in client.post("/api/auth/logout").headers
    for changes in ({"Origin": "https://third-party.example"}, {"Origin": "null"},
                    {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
        bad = {**bound(session), **changes}
        for path in ("/write", "/api/auth/login", "/api/auth/logout"):
            response = client.post(path, headers=bad, json=CREDENTIALS)
            assert response.status_code == 403 and "set-cookie" not in response.headers
    assert client.post("/write", headers={"X-Manji-Session": "cookie",
                       "X-Manji-Session-Id": session["session_id"]}).status_code == 403
    assert client.get("/api/auth/me", headers={**BROWSER, "Authorization": "Bearer " + "x" * 43}).status_code == 409
    assert client.post("/api/auth/login", headers={**BROWSER, "X-Manji-Session-Id": "anonymous"},
                       json=CREDENTIALS).status_code == 409
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + token}).status_code == 200


def test_cookie_mode_permits_loopback_http_but_rejects_remote_http_before_login(client):
    uri = "/api/auth/login"
    assert client.post("/api/auth/register", json=CREDENTIALS).status_code == 201
    with TestClient(client.app, base_url="http://localhost:8000") as local:
        login = local.post(uri, json=CREDENTIALS, headers={**BROWSER, "Origin": "http://localhost:8000"})
        assert login.status_code == 200 and "Secure" not in login.headers["set-cookie"]
        token = local.cookies["manji_session"]
    with TestClient(client.app, base_url="http://manji.example") as remote:
        login = remote.post(uri, json=CREDENTIALS, headers={**BROWSER, "Origin": "http://manji.example"})
        assert login.status_code == 403 and "set-cookie" not in login.headers
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + token}).status_code == 200


def test_legacy_guest_can_upgrade_to_browser_session_and_keep_original_user(client):
    guest = client.app.state.auth.start_guest()
    old_bearer = {"Authorization": "Bearer " + guest["token"]}
    assert client.get("/api/auth/me", headers={**old_bearer, **BROWSER}).json()["is_guest"]
    upgrade = client.post("/api/auth/register", json=CREDENTIALS, headers={**old_bearer, **BROWSER})
    assert upgrade.status_code == 201 and upgrade.json()["user"]["id"] == guest["user"]["id"]
    assert client.get("/api/auth/me", headers=old_bearer).status_code == 401
    assert client.get("/api/auth/me", headers=bound(upgrade.json())).json()["is_guest"] is False


def test_sms_login_sets_only_cookie_and_public_id(client):
    sender = Mock(spec=TencentSmsSender)
    repository = Mock(spec=AuthRepository)
    repository.login_with_verified_phone.return_value = {
        "id": 12, "username": "sms:internal", "create_time": "2026-11-24T10:00:00Z",
    }
    client.app.state.sms_auth = SmsAuthService(repository, sender)
    phone = "13900001234"
    assert client.post("/api/auth/sms/send", json={"phone": phone}, headers=BROWSER).status_code == 200
    code = sender.send_code.call_args.args[1]
    logged = client.post("/api/auth/sms/login", json={"phone": phone, "code": code}, headers=BROWSER)
    assert logged.status_code == 200 and set(logged.json()) == {"user", "session_id"}
    assert client.cookies["manji_session"] not in logged.text
    assert "HttpOnly" in logged.headers["set-cookie"]


def test_legacy_member_exchange_is_bound_single_use_and_cannot_renew_cookie(client):
    assert client.post("/api/auth/register", json=CREDENTIALS).status_code == 201
    first = client.post("/api/auth/login", json=CREDENTIALS).json()
    old = {"Authorization": "Bearer " + first["token"]}
    origin_headers = {**old, **BROWSER}
    session_id = client.get("/api/auth/me", headers=origin_headers).json()["session_id"]
    route = "/api/auth/session/upgrade"
    assert client.post(route, headers=old).status_code == 403
    assert client.post(route, headers=BROWSER).status_code == 401
    assert client.post(route, headers={**origin_headers, "Origin": "https://wrong.example"}).status_code == 403
    upgrade = client.post(route, headers={**origin_headers, "X-Manji-Session-Id": session_id})
    assert upgrade.status_code == 200 and upgrade.json()["user"] == first["user"]
    assert set(upgrade.json()) == {"user", "session_id"} and session_id != upgrade.json()["session_id"]
    assert "HttpOnly" in upgrade.headers["set-cookie"]
    token = client.cookies["manji_session"]
    assert client.post(route, headers=origin_headers).status_code == 409
    assert client.get("/api/auth/me", headers=bound(upgrade.json())).status_code == 200
    client.cookies.clear()
    assert client.post(route, headers=origin_headers).status_code == 401
    assert client.post(route, headers={**BROWSER, "Authorization": "Bearer " + token}).status_code == 401
    guest = client.app.state.auth.start_guest()
    assert client.post(route, headers={**BROWSER, "Authorization": "Bearer " + guest["token"]}).status_code == 403


def test_member_expiry_is_fixed_and_revocation_is_conditioned_on_exact_token(guest_database):
    repository = AuthRepository(guest_database)
    user = repository.create_user("member", "hash", "first-token")
    sms_user = repository.login_with_verified_phone("+8613900001234", "sms:member", "hash", "sms-token")
    with psycopg.connect(guest_database, autocommit=True) as connection:
        def expiry(user_id):
            return connection.execute("SELECT token_expires_at FROM users WHERE id=%s", (user_id,)).fetchone()[0]
        now = connection.execute("SELECT statement_timestamp()").fetchone()[0]
        first_expiry = expiry(user["id"])
        for expires in (first_expiry, expiry(sms_user["id"])):
            assert now + timedelta(days=30, seconds=-5) < expires <= now + timedelta(days=30)
        assert repository.find_user_id_by_token("first-token") == user["id"]
        assert expiry(user["id"]) == first_expiry
        connection.execute("UPDATE users SET token_expires_at = statement_timestamp() WHERE id=%s", (user["id"],))
        assert repository.find_user_by_token("first-token") is None
        assert repository.exchange_member_token("first-token", "replacement") is None
        repository.update_token(user["id"], "new-token")
        repository.revoke_token("first-token")
        assert repository.find_user_id_by_token("new-token") == user["id"]
        assert expiry(user["id"]) >= first_expiry
        repository.revoke_token("new-token")
        assert expiry(user["id"]) is None and repository.find_user_by_token("new-token") is None


def test_only_one_concurrent_exchange_can_replace_the_legacy_digest(guest_database):
    repository = AuthRepository(guest_database)
    user = repository.create_user("legacy", "hash", "old-hash")
    start = Barrier(2)

    def exchange(replacement):
        start.wait(timeout=5)
        return repository.exchange_member_token("old-hash", replacement)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(exchange, ("first", "second")))
    assert results.count(user) == 1 and results.count(None) == 1
    assert repository.find_user_by_token("old-hash") is None
    assert sum(repository.find_user_by_token(key) is not None for key in ("first", "second")) == 1

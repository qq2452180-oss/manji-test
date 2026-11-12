"""正式账号准入、旧游客原地绑定及可选 PostgreSQL 事务验证。"""

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import os
import re
import uuid
from unittest.mock import Mock

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.encoders import jsonable_encoder
from fastapi.testclient import TestClient
from langchain_core.messages import HumanMessage
from PIL import Image
import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
import pytest

from src.api.auth.router import router
from src.common.migrate import load_migrations
from src.service.auth import AuthRepository, AuthService
from src.tests.postprocessing_support import stub_postprocessing


class MemoryAuthRepository:
    def __init__(self):
        self.users = {}

    @staticmethod
    def public(user):
        return {key: user[key] for key in ("id", "username", "create_time")}

    def create_user(self, username, password_hash):
        if any(user["username"] == username for user in self.users.values()):
            raise psycopg.errors.UniqueViolation("duplicate username")
        user = {
            "id": len(self.users) + 1, "username": username, "password": password_hash,
            "token": None, "is_guest": False, "create_time": datetime.now(timezone.utc),
        }
        self.users[user["id"]] = user
        return self.public(user)

    def create_guest(self, username, password_hash, token_hash):
        user = self.users[self.create_user(username, password_hash)["id"]]
        user.update(is_guest=True, token=token_hash)
        return {**self.public(user), "is_guest": True}

    def find_by_username(self, username):
        return next((deepcopy(user) for user in self.users.values()
                     if user["username"] == username and not user["is_guest"]), None)

    def update_token(self, user_id, token_hash):
        user = self.users[user_id]
        user["token"] = token_hash
        return self.public(user)

    def find_user_by_token(self, token_hash):
        user = next((user for user in self.users.values() if user["token"] == token_hash), None)
        return {"id": user["id"], "is_guest": user["is_guest"]} if user else None

    def find_user_id_by_token(self, token_hash):
        user = self.find_user_by_token(token_hash)
        return user["id"] if user else None

    def upgrade_guest(self, token_hash, username, password_hash):
        user = next((user for user in self.users.values()
                     if user["token"] == token_hash and user["is_guest"]), None)
        if user is None:
            return None
        if any(candidate["username"] == username for candidate in self.users.values()):
            raise psycopg.errors.UniqueViolation("duplicate username")
        user.update(username=username, password=password_hash, is_guest=False)
        return self.public(user)


def make_client(repository):
    app = FastAPI()
    app.state.auth = AuthService(repository)
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def auth():
    repository = MemoryAuthRepository()
    with make_client(repository) as client:
        yield client, repository


def bearer(token):
    return {"Authorization": "Bearer " + token}


def register(client, username="member", headers=None):
    return client.post("/api/auth/register", headers=headers,
                       json={"username": username, "password": "private-password"})


def legacy_guest(client):
    """准备停用游客入口前已保存的身份，不经已关闭的公开接口创建。"""
    return client.app.state.auth.start_guest()


def assert_private(response):
    assert response.headers["cache-control"] == "private, no-store"


def test_new_guest_creation_is_disabled_without_touching_storage(auth, monkeypatch):
    client, repository = auth
    create = Mock()
    monkeypatch.setattr(client.app.state.auth, "start_guest", create)
    response = client.post("/api/auth/guest")
    assert response.status_code == 403
    assert response.json() == {"detail": "请先注册或登录账号"}
    assert_private(response)
    create.assert_not_called()
    assert repository.users == {}


def test_legacy_guest_only_stores_hashes_and_can_still_read_identity(auth):
    client, repository = auth
    payload = legacy_guest(client)
    assert set(payload) == {"token", "user"}
    assert set(payload["user"]) == {"id", "username", "create_time", "is_guest"}
    assert payload["user"]["is_guest"] is True
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", payload["token"])
    stored = repository.users[payload["user"]["id"]]
    assert stored["username"].startswith("guest:")
    assert stored["password"].startswith("$argon2id$")
    assert stored["token"] == hashlib.sha256(payload["token"].encode()).hexdigest()
    response = client.get("/api/auth/me", headers=bearer(payload["token"]))
    assert response.status_code == 200
    assert_private(response)
    assert stored["password"] not in response.text
    assert stored["token"] not in response.text
    assert client.get("/api/auth/me", headers=bearer(payload["token"])).json() == {
        "user_id": stored["id"], "is_guest": True,
    }
    second = legacy_guest(client)
    assert second["user"]["id"] != stored["id"]
    assert second["user"]["username"] != stored["username"]
    assert second["token"] != payload["token"]


def test_business_routes_reject_legacy_guests_before_services_run(auth):
    from src.api.home.router import router as home_router
    from src.api.interview.router import router as interview_router
    from src.api.rtc.router import router as rtc_router

    client, repository = auth
    for api in (home_router, interview_router, rtc_router):
        client.app.include_router(api)
    services = [Mock() for _ in range(4)]
    for name, service in zip(("home", "interview", "media", "rtc"), services):
        setattr(client.app.state, name, service)
    guest = legacy_guest(client)
    headers = bearer(guest["token"])
    routes = [
        ("GET", "/api/home", {}),
        ("GET", "/api/stories/1", {}),
        ("PATCH", "/api/stories/1", {"json": {"title": "标题", "body": "正文", "photo_layout": []}}),
        ("GET", "/api/biography", {}),
        ("GET", "/api/chapters/1", {}),
        ("POST", "/api/interviews", {"json": {"topic_id": 1}}),
        ("GET", "/api/interviews/1", {}),
        ("PATCH", "/api/interviews/1/mode", {"json": {"resume_mode": "text"}}),
        ("POST", "/api/interviews/1/input", {"json": {"text": "讲述"}}),
        ("POST", "/api/interviews/1/photos", {"files": {"photo": ("photo.png", b"unused", "image/png")}}),
        ("GET", "/api/interviews/1/photos/1", {}),
        ("POST", "/api/interviews/1/finish", {}),
        ("POST", "/api/interviews/1/retry", {}),
        ("POST", "/api/interviews/1/calls", {"json": {"client_request_id": "new-call"}}),
        ("POST", "/api/rtc/calls/" + "a" * 32 + "/start", {}),
        ("GET", "/api/rtc/calls/" + "a" * 32, {}),
    ]
    for method, path, options in routes:
        assert client.request(method, path, **options).status_code == 401, path
        response = client.request(method, path, headers=headers, **options)
        assert response.status_code == 403, path
        assert_private(response)
        assert "www-authenticate" not in response.headers
    assert all(not service.mock_calls for service in services)
    assert client.get("/api/auth/me", headers=headers).json() == {
        "user_id": guest["user"]["id"], "is_guest": True,
    }
    assert register(client, headers=headers).status_code == 201
    client.app.state.home.get_home.return_value = {"stories": []}
    assert client.get("/api/home", headers=headers).json() == {"stories": []}
    client.app.state.home.get_home.assert_called_once_with(guest["user"]["id"])


def test_guest_registration_preserves_owner_and_token_until_explicit_login(auth):
    client, repository = auth
    guest = legacy_guest(client)
    user_id = guest["user"]["id"]
    before = deepcopy(repository.users[user_id])
    upgraded = register(client, "  Member_Name  ", bearer(guest["token"]))
    assert upgraded.status_code == 201
    assert set(upgraded.json()) == {"id", "username", "create_time"}
    assert upgraded.json()["id"] == user_id
    assert upgraded.json()["username"] == "member_name"
    assert len(repository.users) == 1
    stored = repository.users[user_id]
    assert stored["create_time"] == before["create_time"]
    assert stored["token"] == before["token"]
    assert not stored["is_guest"]
    assert PasswordHasher().verify(stored["password"], "private-password")
    assert client.get("/api/auth/me", headers=bearer(guest["token"])).json() == {
        "user_id": user_id, "is_guest": False,
    }
    login = client.post("/api/auth/login", json={
        "username": "member_name", "password": "private-password",
    })
    assert login.status_code == 200
    assert login.json()["user"] == upgraded.json()
    assert login.json()["token"] != guest["token"]
    assert client.get("/api/auth/me", headers=bearer(guest["token"])).status_code == 401
    assert client.get("/api/auth/me", headers=bearer(login.json()["token"])).json() == {
        "user_id": user_id, "is_guest": False,
    }


def test_anonymous_register_keeps_existing_no_token_contract(auth):
    client, repository = auth
    response = register(client)
    assert response.status_code == 201
    assert set(response.json()) == {"id", "username", "create_time"}
    stored = repository.users[response.json()["id"]]
    assert not stored["is_guest"]
    assert stored["token"] is None


@pytest.mark.parametrize("authorization", [
    "", "Bearer", "Basic ignored", "Bearer invalid", "Bearer " + "x" * 43,
    "Bearer first second",
])
def test_supplied_invalid_authorization_never_becomes_anonymous_registration(auth, authorization):
    client, repository = auth
    response = register(client, headers={"Authorization": authorization})
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert_private(response)
    assert repository.users == {}
    assert "private-password" not in response.text


def test_duplicate_authorization_is_rejected_without_upgrading_guest(auth):
    client, repository = auth
    guest = legacy_guest(client)
    response = register(client, headers=[
        ("Authorization", "Bearer " + guest["token"]),
        ("Authorization", "Bearer " + guest["token"]),
    ])
    assert response.status_code == 401
    assert repository.users[guest["user"]["id"]]["is_guest"]


def test_member_bearer_cannot_register_another_account(auth):
    client, repository = auth
    register(client)
    token = client.post("/api/auth/login", json={
        "username": "member", "password": "private-password",
    }).json()["token"]
    assert register(client, "another", bearer(token)).status_code == 409
    assert len(repository.users) == 1


def test_guest_cannot_password_login_even_with_valid_username_and_password(auth):
    client, repository = auth
    guest = legacy_guest(client)
    stored = repository.users[guest["user"]["id"]]
    stored.update(username="known_guest", password=PasswordHasher().hash("known-password"))
    before_token = stored["token"]
    response = client.post("/api/auth/login", json={
        "username": "known_guest", "password": "known-password",
    })
    assert response.status_code == 401
    assert stored["token"] == before_token


def test_username_conflict_preserves_guest_identity_and_credentials(auth):
    client, repository = auth
    register(client)
    guest = legacy_guest(client)
    before = deepcopy(repository.users[guest["user"]["id"]])
    response = register(client, headers=bearer(guest["token"]))
    assert response.status_code == 409
    assert repository.users[guest["user"]["id"]] == before
    assert client.get("/api/auth/me", headers=bearer(guest["token"])).status_code == 200


def test_token_changed_during_upgrade_cannot_update_or_create_an_account(auth, monkeypatch):
    client, repository = auth
    guest = legacy_guest(client)
    monkeypatch.setattr(repository, "upgrade_guest", lambda *_: None)
    assert register(client, headers=bearer(guest["token"])).status_code == 401
    assert len(repository.users) == 1
    assert repository.users[guest["user"]["id"]]["is_guest"]


def test_storage_failures_are_private_and_do_not_expose_details(auth, monkeypatch):
    client, repository = auth

    def fail(*_):
        raise psycopg.OperationalError("sensitive-connection-details")

    monkeypatch.setattr(repository, "create_user", fail)
    response = register(client)
    assert response.status_code == 503
    assert_private(response)
    assert "sensitive-connection-details" not in response.text


@pytest.mark.parametrize("enabled", [False, True], ids=["disabled", "incomplete"])
def test_app_starts_without_rtc_and_auth_uses_current_identity_contract(monkeypatch, tmp_path, enabled):
    from src.api.app import create_app
    from src.api.rtc.config import load_rtc_provider

    repository = MemoryAuthRepository()
    monkeypatch.setattr("src.api.app.load_dotenv", lambda *args, **kwargs: None)
    monkeypatch.setattr("src.api.app.AuthRepository", lambda _database_url: repository)
    monkeypatch.setattr("src.api.app.load_rtc_provider", lambda: load_rtc_provider({
        "MANJI_LANGGRAPH_RTC_ENABLED": "true" if enabled else "false",
    }))
    with TestClient(create_app(database_url="", media_directory=tmp_path)) as client:
        assert client.app.state.rtc is None
        assert isinstance(client.app.state.auth, AuthService)
        registered = register(client)
        assert registered.status_code == 201
        logged_in = client.post("/api/auth/login", json={
            "username": "member", "password": "private-password",
        })
        assert logged_in.status_code == 200
        headers = bearer(logged_in.json()["token"])
        identity = client.get("/api/auth/me", headers=headers)
        assert identity.status_code == 200
        assert identity.json() == {"user_id": registered.json()["id"], "is_guest": False}
        assert_private(identity)
        unavailable = client.post("/api/rtc/calls/call-1/start", headers=headers)
        assert unavailable.status_code == 503
        assert unavailable.json()["code"] == "RTC_UNAVAILABLE"
        assert client.post("/api/auth/guest").status_code == 403
        guest = legacy_guest(client)
        assert client.get("/api/auth/me", headers=bearer(guest["token"])).json() == {
            "user_id": guest["user"]["id"], "is_guest": True,
        }
        index = client.get("/", follow_redirects=False)
        assert index.headers["location"] == "/web/index.html"


@pytest.fixture
def guest_database(monkeypatch):
    stub_postprocessing(monkeypatch)
    database_url = (os.getenv("MANJILU_TEST_DATABASE_URL")
                    or os.getenv("MANJI_TEST_DATABASE_URL") or "").strip()
    if not database_url:
        pytest.skip("Set MANJILU_TEST_DATABASE_URL to a dedicated PostgreSQL test database")
    settings = conninfo_to_dict(database_url)
    if not settings.get("dbname", "").endswith("_test"):
        pytest.fail("Guest tests require a database name ending in _test", pytrace=False)
    schema = "src_guest_" + uuid.uuid4().hex
    options = (settings.get("options", "") + f" -c search_path={schema}").strip()
    scoped_url = make_conninfo(database_url, options=options)
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    try:
        with psycopg.connect(scoped_url) as connection:
            for migration in load_migrations():
                connection.execute(migration.sql, prepare=False)
            connection.execute(
                "INSERT INTO chapter (title, sort_order) VALUES "
                "('童年', 1), ('少年', 2), ('青年', 3), "
                "('中年', 4), ('晚年', 5), ('人生回望', 6)"
            )
            connection.execute(
                "INSERT INTO topic (chapter_id, title, description) VALUES "
                "(1, '住过的地方', '早年住处的景物与生活片段。')"
            )
            connection.execute("CREATE TABLE owned_material (user_id BIGINT REFERENCES users(id))")
        yield scoped_url
    finally:
        with psycopg.connect(database_url, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def test_postgres_upgrade_preserves_references_and_conflict_rolls_back(guest_database):
    with make_client(AuthRepository(guest_database)) as client:
        register(client)
        guest = legacy_guest(client)
        user_id = guest["user"]["id"]
        with psycopg.connect(guest_database, row_factory=dict_row) as connection:
            connection.execute("INSERT INTO owned_material (user_id) VALUES (%s)", (user_id,))
            before = connection.execute("SELECT * FROM users WHERE id = %s", (user_id,)).fetchone()
        assert register(client, headers=bearer(guest["token"])).status_code == 409
        with psycopg.connect(guest_database, row_factory=dict_row) as connection:
            assert connection.execute("SELECT * FROM users WHERE id = %s", (user_id,)).fetchone() == before
        upgraded = register(client, "new_member", bearer(guest["token"]))
        assert upgraded.status_code == 201
        assert upgraded.json()["id"] == user_id
        with psycopg.connect(guest_database, row_factory=dict_row) as connection:
            stored = connection.execute("SELECT * FROM users WHERE id = %s", (user_id,)).fetchone()
            assert stored["is_guest"] is False
            assert stored["token"] == before["token"]
            assert stored["create_time"] == before["create_time"]
            assert connection.execute("SELECT user_id FROM owned_material").fetchone()["user_id"] == user_id
            assert connection.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"] == 2


def test_postgres_full_interview_keeps_messages_photos_and_story_after_guest_upgrade(
    guest_database, monkeypatch, tmp_path,
):
    from src.api.app import create_app

    opening = Mock(return_value="想聊哪段往事？")
    interviewer = Mock(return_value='{"assistant_text":"那张照片还有什么故事？"}')
    writer = Mock(return_value='{"title":"家门前的合影","body":"我小时候住在乡下，这是我和家人在家门前的合影。"}')

    def reply(messages, **kwargs):
        has_user_input = any(isinstance(message, HumanMessage) and message.id for message in messages)
        model = interviewer if has_user_input else opening
        return model(messages, **kwargs)

    monkeypatch.setattr("src.langgraph.node.interview.call_qwen", reply)
    monkeypatch.setattr("src.langgraph.node.writing.call_qwen", writer)
    monkeypatch.setattr("src.langgraph.node.summary.call_qwen", Mock(return_value='{"summary":"用户讲述了童年住在乡下，以及和家人在家门前合影的经历。"}'))
    monkeypatch.setattr("src.api.app.load_rtc_provider", lambda: None)
    photo = BytesIO()
    Image.new("RGB", (4, 4), "blue").save(photo, format="PNG")
    photo_bytes = photo.getvalue()

    def saved_material():
        with psycopg.connect(guest_database, row_factory=dict_row) as connection:
            return {
                table: connection.execute(
                    sql.SQL("SELECT * FROM {} ORDER BY id").format(sql.Identifier(table))
                ).fetchall()
                for table in ("interview_sessions", "media", "story")
            }

    with TestClient(create_app(database_url=guest_database, media_directory=tmp_path)) as client:
        guest = legacy_guest(client)
        user_id = guest["user"]["id"]
        old_headers = bearer(guest["token"])
        # 准备停用入口前的历史访谈；当前 HTTP 接口不再允许游客创建这些内容。
        interview = client.app.state.interview
        started = interview.start(user_id, topic_id=1)
        session_id = started["session_id"]
        path = "/api/interviews/" + session_id
        interview.submit_text(user_id, session_id, "我小时候住在乡下。")
        interview.upload_photo(user_id, session_id, BytesIO(photo_bytes), "这是我和家人在家门前的合影。")
        finished = interview.finish(user_id, session_id)
        assert finished["status"] == "completed"
        assert finished["chapter_id"] == 1
        before_session = jsonable_encoder(interview.get_session(user_id, session_id))
        assert len(before_session["messages"]) == 5
        photo_message = next(message for message in before_session["messages"] if message["image_ids"])
        media_id = photo_message["image_ids"][0]
        assert "source_session_id" not in finished
        assert "photo_layout" not in finished
        story_path = f"/api/stories/{finished['story_id']}"
        story = jsonable_encoder(client.app.state.home.get_story(user_id, finished["story_id"]))
        assert story["source_session_id"] == session_id
        assert story["photo_layout"] == []
        assert story["body"] == finished["body"]
        before_material = saved_material()
        assert [len(before_material[table]) for table in ("interview_sessions", "media", "story")] == [1, 1, 1]
        assert all(row["user_id"] == user_id for rows in before_material.values() for row in rows)
        assert before_material["story"][0]["id"] == finished["story_id"]
        assert before_material["story"][0]["chapter_id"] == 1
        assert before_material["story"][0]["source_session_id"] == session_id
        assert before_material["story"][0]["photo_layout"] == []
        assert client.get(path, headers=old_headers).status_code == 403
        assert client.get(story_path, headers=old_headers).status_code == 403
        assert client.get(path + f"/photos/{media_id}", headers=old_headers).status_code == 403

        upgraded = register(client, "retained_owner", old_headers)
        assert upgraded.status_code == 201
        assert upgraded.json()["id"] == user_id
        assert client.get(path, headers=old_headers).json() == before_session
        assert client.get(story_path, headers=old_headers).json() == story
        logged_in = client.post("/api/auth/login", json={
            "username": "retained_owner", "password": "private-password",
        })
        assert logged_in.status_code == 200
        assert logged_in.json()["user"]["id"] == user_id
        new_headers = bearer(logged_in.json()["token"])
        assert client.get("/api/auth/me", headers=new_headers).json() == {
            "user_id": user_id, "is_guest": False,
        }
        assert client.get(path, headers=old_headers).status_code == 401
        assert client.get(path, headers=new_headers).json() == before_session
        assert client.get(story_path, headers=new_headers).json() == story
        restored_photo = client.get(path + f"/photos/{media_id}", headers=new_headers)
        assert restored_photo.status_code == 200
        assert restored_photo.content == photo_bytes
        assert client.post(path + "/finish", headers=new_headers).json() == finished
        assert saved_material() == before_material

        assert register(client, "outsider").status_code == 201
        outsider = client.post("/api/auth/login", json={
            "username": "outsider", "password": "private-password",
        }).json()
        outsider_headers = bearer(outsider["token"])
        assert client.get(path, headers=outsider_headers).status_code == 404
        assert client.get(path + f"/photos/{media_id}", headers=outsider_headers).status_code == 404
        opening.assert_called_once()
        assert interviewer.call_count == 2
        writer.assert_called_once()

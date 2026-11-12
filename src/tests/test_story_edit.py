"""已完成故事编辑：真实隔离 PostgreSQL 的权限、原子保存及重读验证。"""

from copy import deepcopy
from unittest.mock import Mock

from fastapi.encoders import jsonable_encoder
from fastapi.testclient import TestClient
from langchain_core.messages import HumanMessage
import psycopg
from psycopg.rows import dict_row
import pytest

from src.api.app import create_app
from src.service.media.repository import MediaRepository
from src.service.story import StoryRepository
from src.tests.test_guest_auth import bearer, guest_database, legacy_guest, register  # noqa: F401
from src.tests.test_home import home_app, new_user, save_interview  # noqa: F401


@pytest.fixture
def edit_app(home_app, monkeypatch):
    models = []
    for node in ("interview", "writing"):
        model = Mock(side_effect=AssertionError("故事编辑不能调用模型"))
        monkeypatch.setattr(f"src.langgraph.node.{node}.call_qwen", model)
        models.append(model)
    yield home_app
    for model in models:
        model.assert_not_called()


def seed_story(database, owner, *, photos=True, completed=True):
    session_id = save_interview(database, owner, [HumanMessage(content="原始讲述")], finished=True)
    layout = []
    if photos:
        media = MediaRepository(database)
        layout = [
            {"media_id": media.create(owner, session_id, session_id + "/first.jpg"),
             "after_paragraph": 1},
            {"media_id": media.create(owner, session_id, session_id + "/last.jpg"),
             "after_paragraph": 3},
        ]
    repository = StoryRepository(database)
    story_id = repository.create(
        owner, "原故事", "第一段\n\n第二段\n\n第三段", source_session_id=session_id,
        chapter_id=1, photo_layout=layout,
    )
    if not completed:
        with psycopg.connect(database) as connection:
            connection.execute("UPDATE story SET chapter_id = NULL WHERE id = %s", (story_id,))
    return story_id, layout


def stored_story(database, story_id):
    with psycopg.connect(database, row_factory=dict_row) as connection:
        return connection.execute("SELECT * FROM story WHERE id = %s", (story_id,)).fetchone()


@pytest.mark.parametrize("photos", [False, True], ids=["plain", "photos"])
def test_edit_persists_trimmed_story_and_photo_positions_across_restart(
    edit_app, guest_database, tmp_path, photos,
):
    with TestClient(edit_app) as client:
        owner, headers = new_user(client)
        story_id, layout = seed_story(guest_database, owner, photos=photos)
        before = stored_story(guest_database, story_id)
        with psycopg.connect(guest_database, row_factory=dict_row) as connection:
            original_interviews = connection.execute("SELECT * FROM interview_sessions").fetchall()
            original_media = connection.execute("SELECT * FROM media").fetchall()
        # 插入新段后照片跟随原段；删除第三段后该段照片放在文末。
        if layout:
            layout[0]["after_paragraph"] = 2
            layout[1]["after_paragraph"] = None
        payload = {"title": "  修改后的标题  ", "body": "\n 新增段落。\r\n\r\n改过的第一段。\n第二段。 \n",
                   "photo_layout": layout}
        path = f"/api/stories/{story_id}"
        saved = client.patch(path, headers=headers, json=payload)
        assert saved.status_code == 200
        assert saved.headers["cache-control"] == "private, no-store"
        detail = saved.json()
        assert detail["title"] == payload["title"].strip()
        assert detail["body"] == payload["body"].strip()
        assert detail["photo_layout"] == layout
        assert set(detail) == {"story_id", "title", "body", "create_time", "chapter_id",
                               "source_session_id", "photo_layout", "version", "updated_time",
                               "selected_topic", "active_supplement", "source_sessions", "pending_processing"}
        assert detail["version"] == before["version"] + 1
        assert client.get(path, headers=headers).json() == detail
        chapter = client.get("/api/chapters/1", headers=headers).json()
        assert chapter["stories"] == [{key: value for key, value in detail.items()
                                       if key not in {"chapter_id", "selected_topic", "active_supplement",
                                                      "source_sessions", "pending_processing"}}]
        assert client.get("/api/home", headers=headers).json()["stories"][0]["title"] == detail["title"]
        after = stored_story(guest_database, story_id)
        changed_fields = {"title", "body", "photo_layout", "version", "updated_time"}
        assert {key: after[key] for key in before if key not in changed_fields} == {
            key: value for key, value in before.items() if key not in changed_fields
        }
        with psycopg.connect(guest_database, row_factory=dict_row) as connection:
            assert connection.execute("SELECT * FROM interview_sessions").fetchall() == original_interviews
            assert connection.execute("SELECT * FROM media").fetchall() == original_media
        assert edit_app.state.interview.sessions == {}

    restarted = create_app(database_url=guest_database, media_directory=tmp_path)
    with TestClient(restarted) as client:
        assert client.get(path, headers=headers).json() == detail
        assert client.get("/api/chapters/1", headers=headers).json() == chapter
        assert restarted.state.interview.sessions == {}


def test_edit_requires_auth_and_owned_completed_story(edit_app, guest_database):
    with TestClient(edit_app) as client:
        owner, headers = new_user(client)
        _, other_headers = new_user(client)
        story_id, _ = seed_story(guest_database, owner, photos=False)
        pending, _ = seed_story(guest_database, owner, photos=False, completed=False)
        before = stored_story(guest_database, story_id)
        pending_before = stored_story(guest_database, pending)
        payload = {"title": "不能保存", "body": "不能保存", "photo_layout": []}
        for auth in (None, bearer("invalid")):
            response = client.patch(f"/api/stories/{story_id}", headers=auth, json=payload)
            assert response.status_code == 401
        for target, auth in ((story_id, other_headers), (pending, headers), (999999, headers)):
            response = client.patch(f"/api/stories/{target}", headers=auth, json=payload)
            assert response.status_code == 404
            assert response.json() == {"detail": "故事不存在"}
        assert stored_story(guest_database, story_id) == before
        assert stored_story(guest_database, pending) == pending_before


def test_edit_rejects_added_removed_replaced_or_foreign_photos(edit_app, guest_database):
    with TestClient(edit_app) as client:
        owner, headers = new_user(client)
        other, _ = new_user(client)
        story_id, layout = seed_story(guest_database, owner)
        plain_id, _ = seed_story(guest_database, owner, photos=False)
        _, other_story_layout = seed_story(guest_database, owner)
        _, foreign_layout = seed_story(guest_database, other)
        before = stored_story(guest_database, story_id)
        plain_before = stored_story(guest_database, plain_id)
        extra_same_session = MediaRepository(guest_database).create(
            owner, before["source_session_id"], "unused.jpg",
        )
        invalid = [[], layout[:1], layout + other_story_layout,
                   [layout[0], other_story_layout[0]], [layout[0], foreign_layout[0]],
                   [layout[0], {"media_id": extra_same_session, "after_paragraph": None}],
                   [layout[0], {"media_id": 999999, "after_paragraph": None}]]
        for rejected in invalid:
            response = client.patch(f"/api/stories/{story_id}", headers=headers, json={
                "title": "不应保存", "body": "一\n二\n三", "photo_layout": rejected,
            })
            assert response.status_code == 422
            assert stored_story(guest_database, story_id) == before
        response = client.patch(f"/api/stories/{plain_id}", headers=headers, json={
            "title": "不应保存", "body": "正文", "photo_layout": layout[:1],
        })
        assert response.status_code == 422
        assert stored_story(guest_database, plain_id) == plain_before


def test_edit_invalid_input_never_partially_saves(edit_app, guest_database):
    with TestClient(edit_app) as client:
        owner, headers = new_user(client)
        story_id, layout = seed_story(guest_database, owner)
        before = stored_story(guest_database, story_id)
        valid = {"title": "新标题", "body": "第一段\n第二段\n第三段", "photo_layout": layout}
        invalid = []
        for field in ("title", "body", "photo_layout"):
            missing = deepcopy(valid)
            del missing[field]
            invalid.append(missing)
        for field in ("title", "body"):
            for value in ("", " \n\t", None, True, 123, []):
                invalid.append({**valid, field: value})
        for field in ("revision", "user_id", "chapter_id", "source_session_id", "create_time"):
            invalid.append({**valid, field: 1})
        for value in (None, {}, [None], [layout[0], layout[0]]):
            invalid.append({**valid, "photo_layout": value})
        for field, values in (("media_id", (None, True, 0, -1, "1", 1.0)),
                              ("after_paragraph", (True, 0, -1, "1", 1.0, 4))):
            for value in values:
                invalid.append({**valid, "photo_layout": [{**layout[0], field: value}, layout[1]]})
            missing = deepcopy(layout[0])
            del missing[field]
            invalid.append({**valid, "photo_layout": [missing, layout[1]]})
        invalid.append({**valid, "photo_layout": [{**layout[0], "caption": "非法字段"}, layout[1]]})
        for payload in invalid:
            response = client.patch(f"/api/stories/{story_id}", headers=headers, json=payload)
            assert response.status_code == 422, payload
            assert stored_story(guest_database, story_id) == before


def test_later_successful_save_overwrites_without_revision(edit_app, guest_database):
    with TestClient(edit_app) as client:
        owner, headers = new_user(client)
        story_id, _ = seed_story(guest_database, owner, photos=False)
        path = f"/api/stories/{story_id}"
        first_tab = client.get(path, headers=headers).json()
        second_tab = client.get(path, headers=headers).json()
        for snapshot, title in ((first_tab, "第一次修改"), (second_tab, "后一次修改")):
            response = client.patch(path, headers=headers, json={
                "title": title, "body": snapshot["body"], "photo_layout": snapshot["photo_layout"],
            })
            assert response.status_code == 200
        assert client.get(path, headers=headers).json()["title"] == "后一次修改"
        assert "revision" not in stored_story(guest_database, story_id)


def test_guest_upgrade_and_login_preserve_edited_story(edit_app, guest_database):
    with TestClient(edit_app) as client:
        guest = legacy_guest(client)
        owner, headers = guest["user"]["id"], bearer(guest["token"])
        story_id, layout = seed_story(guest_database, owner)
        path = f"/api/stories/{story_id}"
        for photo in layout:
            photo["after_paragraph"] = None
        # 准备游客入口停用前已保存的编辑内容，不绕过当前接口的会员限制。
        saved = jsonable_encoder(client.app.state.home.update_story(
            owner, story_id, "游客修改", "已修改的正文。", layout,
        ))
        after_edit = stored_story(guest_database, story_id)
        assert after_edit["user_id"] == owner
        assert saved["photo_layout"] == layout
        assert client.get(path, headers=headers).status_code == 403
        assert client.patch(path, headers=headers, json={
            "title": "不应保存", "body": "游客不能继续编辑。", "photo_layout": layout,
        }).status_code == 403
        assert stored_story(guest_database, story_id) == after_edit
        upgraded = register(client, "edited_guest", headers)
        assert upgraded.status_code == 201
        assert upgraded.json()["id"] == owner
        assert client.get(path, headers=headers).json() == saved
        login = client.post("/api/auth/login", json={
            "username": "edited_guest", "password": "private-password",
        })
        assert login.status_code == 200
        assert login.json()["user"]["id"] == owner
        assert client.get(path, headers=bearer(login.json()["token"])).json() == saved
        assert client.get(path, headers=headers).status_code == 401
        assert stored_story(guest_database, story_id) == after_edit


def test_database_update_failure_returns_private_error_and_rolls_back(edit_app, guest_database):
    with TestClient(edit_app) as client:
        owner, headers = new_user(client)
        story_id, layout = seed_story(guest_database, owner)
        before = stored_story(guest_database, story_id)
        with psycopg.connect(guest_database) as connection:
            connection.execute("""
                CREATE FUNCTION reject_story_edit() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'private database failure'; END $$;
                CREATE TRIGGER reject_story_edit AFTER UPDATE ON story
                    FOR EACH ROW EXECUTE FUNCTION reject_story_edit();
            """)
        response = client.patch(f"/api/stories/{story_id}", headers=headers, json={
            "title": "不应保存", "body": "一\n二\n三", "photo_layout": layout,
        })
        assert response.status_code == 503
        assert response.headers["cache-control"] == "private, no-store"
        assert response.json() == {"detail": "故事暂时无法保存，请稍后重试"}
        assert "private database" not in response.text
        assert stored_story(guest_database, story_id) == before

"""传记目录与章节只读取当前用户已有章节的故事。"""

from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from src.api.app import create_app
from src.api.home.router import home_error, router
from src.service.home import HomeError, HomeService
from src.tests.test_guest_auth import bearer, guest_database  # noqa: F401
from src.tests.test_home import home_app, new_user, save_story  # noqa: F401


@pytest.mark.parametrize("path, method", [
    ("/api/biography", "list_user_chapters"),
    ("/api/chapters/1", "get_chapter"),
])
def test_biography_reads_require_auth_and_reuse_private_errors(path, method):
    app = FastAPI()
    app.state.auth = Mock()
    app.state.auth.get_user.return_value = {"id": 10, "is_guest": False}
    stories = Mock()
    app.state.home = HomeService(Mock(), stories)
    app.add_exception_handler(HomeError, home_error)
    app.include_router(router)
    with TestClient(app) as client:
        response = client.get(path)
        assert response.status_code == 401
        assert response.headers["cache-control"] == "private, no-store"
        getattr(stories, method).assert_not_called()
        getattr(stories, method).side_effect = psycopg.OperationalError("private database")
        response = client.get(path, headers=bearer("token"))
        assert response.status_code == 503
        assert response.headers["cache-control"] == "private, no-store"
        assert "private database" not in response.text


def test_empty_biography_and_chapter_do_not_include_other_accounts(home_app, guest_database):
    with TestClient(home_app) as client:
        _, headers = new_user(client)
        other, _ = new_user(client)
        save_story(guest_database, other, "其他账号的童年")
        biography = client.get("/api/biography", headers=headers)
        assert biography.status_code == 200
        assert biography.headers["cache-control"] == "private, no-store"
        assert biography.json() == {"last_story_time": None, "chapters": [], "body": None}
        chapter = client.get("/api/chapters/1", headers=headers)
        assert chapter.status_code == 200
        assert chapter.headers["cache-control"] == "private, no-store"
        assert chapter.json() == {"chapter": {"chapter_id": 1, "title": "童年"}, "stories": []}
        missing = client.get("/api/chapters/999999", headers=headers)
        assert missing.status_code == 404
        assert missing.headers["cache-control"] == "private, no-store"
        assert missing.json() == {"detail": "章节不存在"}


def test_all_owned_chapters_and_stories_are_ordered_without_home_limit(home_app, guest_database):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        other, other_headers = new_user(client)
        same_day = [save_story(guest_database, owner, f"童年故事{n}") for n in range(6)]
        older = save_story(guest_database, owner, "更早整理", created="2026-10-19")
        newer = save_story(guest_database, owner, "后来整理", created="2026-10-21")
        second = save_story(guest_database, owner, "少年故事", chapter_id=2)
        latest = save_story(guest_database, owner, "青年故事", created="2026-10-22", chapter_id=3)
        save_story(guest_database, owner, "还没有归章", created="2026-10-24", completed=False)
        other_story = save_story(guest_database, other, "其他账号的故事", created="2026-10-23")
        with psycopg.connect(guest_database) as connection:
            connection.execute("UPDATE chapter SET sort_order = 2 WHERE id IN (1, 2)")
            connection.execute("UPDATE chapter SET sort_order = 1 WHERE id = 3")

        biography = client.get("/api/biography", headers=headers).json()
        assert biography == {
            "body": None,
            "last_story_time": "2026-10-22T00:00:00+00:00",
            "chapters": [
                {"chapter_id": 3, "title": "青年", "story_count": 1},
                {"chapter_id": 1, "title": "童年", "story_count": 8},
                {"chapter_id": 2, "title": "少年", "story_count": 1},
            ],
        }
        chapter = client.get("/api/chapters/1", headers=headers).json()
        assert chapter["chapter"] == {"chapter_id": 1, "title": "童年"}
        assert [story["story_id"] for story in chapter["stories"]] == [older, *same_day, newer]
        for story in chapter["stories"]:
            detail = client.get(f"/api/stories/{story['story_id']}", headers=headers).json()
            assert story == {key: detail[key] for key in (
                "story_id", "title", "body", "create_time", "source_session_id", "photo_layout", "version", "updated_time",
            )}
        assert client.get("/api/biography", headers=other_headers).json() == {
            "body": None,
            "last_story_time": "2026-10-23T00:00:00+00:00",
            "chapters": [{"chapter_id": 1, "title": "童年", "story_count": 1}],
        }
        assert [story["story_id"] for story in client.get(
            "/api/chapters/1", headers=other_headers,
        ).json()["stories"]] == [other_story]
        assert home_app.state.interview.sessions == {}


def test_biography_and_chapter_survive_app_restart(home_app, guest_database, tmp_path):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        story_id = save_story(guest_database, owner, "已保存的经历")
        paths = ("/api/biography", "/api/chapters/1", f"/api/stories/{story_id}")
        saved = {path: client.get(path, headers=headers).json() for path in paths}
    restarted = create_app(database_url=guest_database, media_directory=tmp_path)
    with TestClient(restarted) as client:
        for path in paths:
            assert client.get(path, headers=headers).json() == saved[path]
        assert restarted.state.interview.sessions == {}

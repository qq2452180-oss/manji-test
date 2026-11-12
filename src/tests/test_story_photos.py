"""故事配图在独立 PostgreSQL 测试 schema 中保存、鉴权和重读。"""

from fastapi.testclient import TestClient
from langchain_core.messages import HumanMessage
import psycopg
import pytest

from src.api.app import create_app
from src.service.media.repository import MediaRepository
from src.service.story import StoryRepository
from src.tests.test_guest_auth import guest_database  # noqa: F401
from src.tests.test_home import home_app, new_user, save_interview  # noqa: F401


def test_story_photos_survive_restart_and_match_chapter(home_app, guest_database, tmp_path):
    repository = StoryRepository(guest_database)
    media = MediaRepository(guest_database)
    body = "童年在河边。\r\n\r\n后来去了城里。\n\n一直珍藏着这张照片。"
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        _, other_headers = new_user(client)
        session_id = save_interview(guest_database, owner, [HumanMessage(content="童年")])
        first = media.create(owner, session_id, "first.jpg")
        last = media.create(owner, session_id, "last.jpg")
        layout = [
            {"media_id": first, "after_paragraph": 1},
            {"media_id": last, "after_paragraph": None},
        ]
        story_id = repository.create(
            owner, "往事", body, chapter_id=1, source_session_id=session_id, photo_layout=layout,
        )
        with psycopg.connect(guest_database) as connection:
            connection.execute("UPDATE story SET chapter_id = NULL WHERE id = %s", (story_id,))
        assert repository.get_completed(owner, story_id) is None
        assert repository.restore_chapter(owner, story_id, 1) == 1
        assert repository.restore_chapter(owner, story_id, 2) == 1
        detail = client.get(f"/api/stories/{story_id}", headers=headers).json()
        assert detail["body"] == body
        assert detail["source_session_id"] == session_id
        assert detail["photo_layout"] == layout
        chapter = client.get("/api/chapters/1", headers=headers).json()
        assert chapter["stories"] == [
            {key: value for key, value in detail.items() if key not in {
                "chapter_id", "selected_topic", "active_supplement", "source_sessions", "pending_processing",
            }},
        ]
        assert client.get(f"/api/stories/{story_id}", headers=other_headers).status_code == 404
        assert client.get("/api/chapters/1", headers=other_headers).json()["stories"] == []

    restarted = create_app(database_url=guest_database, media_directory=tmp_path)
    with TestClient(restarted) as client:
        assert client.get(f"/api/stories/{story_id}", headers=headers).json() == detail
        assert client.get("/api/chapters/1", headers=headers).json() == chapter
        assert restarted.state.interview.sessions == {}


def test_story_rejects_foreign_missing_or_wrong_session_photos(home_app, guest_database):
    repository = StoryRepository(guest_database)
    media = MediaRepository(guest_database)
    with TestClient(home_app) as client:
        owner, _ = new_user(client)
        other, _ = new_user(client)
    session_id = save_interview(guest_database, owner, [])
    another_session = save_interview(guest_database, owner, [])
    other_session = save_interview(guest_database, other, [])
    allowed = media.create(owner, session_id, "allowed.jpg")
    wrong_session = media.create(owner, another_session, "wrong-session.jpg")
    foreign = media.create(other, other_session, "foreign.jpg")
    for rejected in (wrong_session, foreign, foreign + 10000):
        with pytest.raises(ValueError, match="不属于当前用户和访谈"):
            repository.create(owner, "不应保存", "正文", chapter_id=1, source_session_id=session_id,
                              photo_layout=[
                                  {"media_id": allowed, "after_paragraph": 1},
                                  {"media_id": rejected, "after_paragraph": None},
                              ])
    with psycopg.connect(guest_database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM story").fetchone()[0] == 0


def test_story_rejects_invalid_layout_without_partial_save(home_app, guest_database):
    repository = StoryRepository(guest_database)
    with TestClient(home_app) as client:
        owner, _ = new_user(client)
    session_id = save_interview(guest_database, owner, [])
    photo = MediaRepository(guest_database).create(owner, session_id, "photo.jpg")
    invalid_layouts = [
        {}, [None], [{"media_id": True}], [{"media_id": 0}], [{"media_id": "1"}],
        [{"media_id": photo, "after_paragraph": True}],
        [{"media_id": photo, "after_paragraph": 0}],
        [{"media_id": photo, "after_paragraph": -1}],
        [{"media_id": photo, "after_paragraph": 3}],
        [{"media_id": photo, "after_paragraph": "1"}],
        [{"media_id": photo, "after_paragraph": 1},
         {"media_id": photo, "after_paragraph": None}],
    ]
    for layout in invalid_layouts:
        with pytest.raises(ValueError):
            repository.create(owner, "不应保存", "第一段\n\n第二段",
                              chapter_id=1, source_session_id=session_id, photo_layout=layout)
    with pytest.raises(ValueError, match="缺少来源会话"):
        repository.create(owner, "不应保存", "正文", chapter_id=1, photo_layout=[{"media_id": photo}])
    with psycopg.connect(guest_database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM story").fetchone()[0] == 0


def test_plain_story_saves_chapter_and_defaults_to_empty_layout(home_app, guest_database):
    with TestClient(home_app) as client:
        owner, _ = new_user(client)
    repository = StoryRepository(guest_database)
    story_id = repository.create(owner, "原有故事", "原有正文", chapter_id=1)
    saved = repository.get_completed(owner, story_id)
    assert saved["body"] == "原有正文"
    assert saved["chapter_id"] == 1
    assert saved["source_session_id"] is None
    assert saved["photo_layout"] == []

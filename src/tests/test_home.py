"""主页按账号读取保存的访谈和故事；继续访谈沿用原会话。"""

from datetime import datetime, timezone
from unittest.mock import Mock
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage
import psycopg
import pytest

from src.api.app import create_app
from src.api.home.router import home_error, router
from src.common.dialogue.message_ids import messages_to_context
from src.service.home import HomeError, HomeService
from src.service.interview.repository import InterviewSessionRepository
from src.service.story import StoryRepository
from src.tests.test_guest_auth import bearer, guest_database  # noqa: F401


@pytest.fixture
def home_app(guest_database, monkeypatch, tmp_path):
    monkeypatch.setattr("src.api.app.load_rtc_provider", lambda: None)
    return create_app(database_url=guest_database, media_directory=tmp_path)


def new_user(client):
    credentials = {"username": "member_" + uuid4().hex[:24], "password": "test-member-password"}
    registered = client.post("/api/auth/register", json=credentials)
    assert registered.status_code == 201, registered.text
    logged_in = client.post("/api/auth/login", json=credentials)
    assert logged_in.status_code == 200, logged_in.text
    account = logged_in.json()
    assert account["user"]["id"] == registered.json()["id"]
    return account["user"]["id"], bearer(account["token"])


def save_interview(database, owner, messages, *, updated="2026-10-20", finished=False):
    repository = InterviewSessionRepository(database)
    record = repository.create(owner)
    messages = [message.model_copy(update={"id": str(index)}) for index, message in enumerate(messages, 1)]
    repository.save(owner, record["id"], messages_to_context(messages), finished=finished)
    with psycopg.connect(database) as connection:
        connection.execute(
            "UPDATE interview_sessions SET update_time = %s WHERE id = %s",
            (datetime.fromisoformat(updated).replace(tzinfo=timezone.utc), record["id"]),
        )
    return str(record["id"])


def save_story(database, owner, title, *, created="2026-10-20", completed=True, chapter_id=1):
    repository = StoryRepository(database)
    story_id = repository.create(owner, title, "正文：" + title, chapter_id=chapter_id)
    with psycopg.connect(database) as connection:
        connection.execute(
            "UPDATE story SET create_time = %s, chapter_id = %s WHERE id = %s",
            (datetime.fromisoformat(created).replace(tzinfo=timezone.utc), chapter_id if completed else None, story_id),
        )
    return story_id


def test_home_and_story_require_existing_auth_and_keep_errors_private():
    app = FastAPI()
    app.state.auth = Mock()
    app.state.auth.get_user.return_value = {"id": 10, "is_guest": False}
    interviews, stories = Mock(), Mock()
    app.state.home = HomeService(interviews, stories)
    app.add_exception_handler(HomeError, home_error)
    app.include_router(router)
    with TestClient(app) as client:
        for path in ("/api/home", "/api/stories/1"):
            response = client.get(path)
            assert response.status_code == 401
            assert response.headers["cache-control"] == "private, no-store"
        interviews.latest_unfinished.side_effect = psycopg.OperationalError("private database")
        stories.get_completed.side_effect = psycopg.OperationalError("private database")
        for path in ("/api/home", "/api/stories/1"):
            response = client.get(path, headers=bearer("token"))
            assert response.status_code == 503
            assert response.headers["cache-control"] == "private, no-store"
            assert "private database" not in response.text


def test_home_empty_and_latest_saved_unfinished_preview(home_app, guest_database):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        other, _ = new_user(client)
        empty = client.get("/api/home", headers=headers)
        assert empty.status_code == 200
        assert empty.headers["cache-control"] == "private, no-store"
        assert empty.json() == {"unfinished_interview": None, "stories": [], "topic_progress": []}
        save_interview(guest_database, owner, [AIMessage(content="旧开场")])
        save_interview(guest_database, owner, [AIMessage(content="同日较早编号")], updated="2026-10-21")
        preview = "请继续讲讲小时候的故事。" * 12
        latest = save_interview(guest_database, owner, [
            AIMessage(content="开场"), HumanMessage(content="小时候"), AIMessage(content=preview),
        ], updated="2026-10-21")
        save_interview(guest_database, owner, [], updated="2026-10-22")
        save_interview(guest_database, other, [AIMessage(content="其他账号")], updated="2026-10-23")
        result = client.get("/api/home", headers=headers).json()
        assert result == {
            "unfinished_interview": {
                "session_id": latest, "resume_mode": None,
                "update_time": "2026-10-21T00:00:00+00:00", "preview": preview[:100],
                "needs_processing": False,
            }, "stories": [], "topic_progress": [],
        }
        assert home_app.state.interview.sessions == {}


@pytest.mark.parametrize("story_state", [
    None,
    {"chapter_id": None, "profile_processed": False, "life_event_processed": False, "summary": None},
    {"chapter_id": 1, "profile_processed": False, "life_event_processed": False, "summary": None},
    {"chapter_id": 1, "profile_processed": True, "life_event_processed": False, "summary": None},
    {"chapter_id": 1, "profile_processed": True, "life_event_processed": True, "summary": None},
    {"chapter_id": 1, "profile_processed": True, "life_event_processed": True, "summary": " \t\n"},
    {"chapter_id": 1, "profile_processed": True, "life_event_processed": True, "summary": "已完成摘要。"},
], ids=["writing", "legacy-missing-chapter", "profile", "life-event", "summary", "blank-summary", "completed"])
def test_home_keeps_finished_interviews_until_every_processing_step_is_saved(
    home_app, guest_database, story_state,
):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        other, _ = new_user(client)
        session_id = save_interview(guest_database, owner, [
            AIMessage(content="开场"), HumanMessage(content="小时候住在乡下。"), AIMessage(content="这段往事先讲到这里。"),
        ], finished=True)
        save_interview(guest_database, other, [AIMessage(content="其他账号待整理")], updated="2026-10-22", finished=True)
        if story_state is not None:
            with psycopg.connect(guest_database) as connection:
                connection.execute(
                    "INSERT INTO story (user_id, source_session_id, title, body, chapter_id, "
                    "profile_processed, life_event_processed, summary) "
                    "VALUES (%s, %s, '乡下生活', '小时候住在乡下。', %s, %s, %s, %s)",
                    (owner, session_id, story_state["chapter_id"], story_state["profile_processed"],
                     story_state["life_event_processed"], story_state["summary"]),
                )
        response = client.get("/api/home", headers=headers)
        assert response.status_code == 200
        unfinished = response.json()["unfinished_interview"]
        if story_state is not None and story_state["summary"] == "已完成摘要。":
            assert unfinished is None
        else:
            assert unfinished["session_id"] == session_id
            assert unfinished["needs_processing"] is True
            assert unfinished["preview"] == "这段往事先讲到这里。"
        assert home_app.state.interview.sessions == {}


def test_home_processing_status_uses_latest_story_of_the_same_owner(home_app, guest_database):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        other, _ = new_user(client)
        session_id = save_interview(guest_database, owner, [AIMessage(content="待整理")], finished=True)
        with psycopg.connect(guest_database) as connection:
            connection.execute(
                "INSERT INTO story (user_id, source_session_id, title, body, chapter_id, "
                "profile_processed, life_event_processed, summary) VALUES "
                "(%s, %s, '已有完成记录', '正文', 1, TRUE, TRUE, '摘要'), "
                "(%s, %s, '实际最新待整理记录', '正文', NULL, FALSE, FALSE, NULL), "
                "(%s, %s, '其他用户的完成记录', '正文', 1, TRUE, TRUE, '摘要')",
                (owner, session_id, owner, session_id, other, session_id),
            )
        unfinished = client.get("/api/home", headers=headers).json()["unfinished_interview"]
        assert unfinished["session_id"] == session_id
        assert unfinished["needs_processing"] is True


def test_home_recent_five_completed_stories_and_detail_ownership(home_app, guest_database):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        other, other_headers = new_user(client)
        ids = [save_story(guest_database, owner, f"故事{number}") for number in range(6)]
        newest = save_story(guest_database, owner, "最新故事", created="2026-10-21")
        pending = save_story(guest_database, owner, "未归章", created="2026-10-22", completed=False)
        private = save_story(guest_database, other, "其他账号", created="2026-10-23")
        home = client.get("/api/home", headers=headers).json()
        assert home["unfinished_interview"] is None
        assert [story["story_id"] for story in home["stories"]] == [newest, *reversed(ids[2:])]
        assert all(set(story) == {"story_id", "title", "create_time"} for story in home["stories"])
        detail = client.get(f"/api/stories/{newest}", headers=headers)
        assert detail.status_code == 200
        assert detail.headers["cache-control"] == "private, no-store"
        assert detail.json() == {
            "story_id": newest, "title": "最新故事", "body": "正文：最新故事",
            "create_time": "2026-10-21T00:00:00+00:00", "chapter_id": 1,
            "source_session_id": None, "photo_layout": [],
            "version": 1, "updated_time": detail.json()["updated_time"],
            "selected_topic": None, "active_supplement": None,
            "source_sessions": [], "pending_processing": None,
        }
        for story_id in (private, pending, 999999):
            missing = client.get(f"/api/stories/{story_id}", headers=headers)
            assert missing.status_code == 404
            assert missing.json() == {"detail": "故事不存在"}
            assert missing.headers["cache-control"] == "private, no-store"
        assert client.get(f"/api/stories/{newest}", headers=other_headers).status_code == 404


def test_home_does_not_restore_graph_or_read_saved_photos(home_app, guest_database, monkeypatch):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        session_id = save_interview(guest_database, owner, [
            AIMessage(content="开场"),
            HumanMessage(content="合影", additional_kwargs={"media_ids": [123]}),
            AIMessage(content="照片拍在哪里？"),
        ])
        restore = Mock(side_effect=AssertionError("主页不恢复图"))
        read_photo = Mock(side_effect=AssertionError("主页不读图片"))
        monkeypatch.setattr(home_app.state.interview._session_manager, "_restore_session", restore)
        monkeypatch.setattr(home_app.state.media, "read", read_photo)
        result = client.get("/api/home", headers=headers)
        assert result.status_code == 200
        assert result.json()["unfinished_interview"]["session_id"] == session_id
        assert result.json()["unfinished_interview"]["preview"] == "照片拍在哪里？"
        restore.assert_not_called()
        read_photo.assert_not_called()


def test_restart_reads_story_and_continues_original_saved_interview(
    home_app, guest_database, monkeypatch, tmp_path,
):
    opening = Mock(return_value="想聊哪段往事？")
    interviewer = Mock(return_value='{"assistant_text":"后来呢？"}')

    def reply(messages, **kwargs):
        has_user_input = any(isinstance(message, HumanMessage) and message.id for message in messages)
        model = interviewer if has_user_input else opening
        return model(messages, **kwargs)

    monkeypatch.setattr("src.langgraph.node.interview.call_qwen", reply)
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        started = client.post("/api/interviews", headers=headers, json={"topic_id": 1})
        assert started.status_code == 201
        session_id = started.json()["session_id"]
        assert client.post(f"/api/interviews/{session_id}/input", headers=headers,
                           json={"text": "小时候在乡下。"}).status_code == 200
        before = client.get(f"/api/interviews/{session_id}", headers=headers).json()
        story_id = save_story(guest_database, owner, "保存的故事")
        detail = client.get(f"/api/stories/{story_id}", headers=headers).json()
    restarted = create_app(database_url=guest_database, media_directory=tmp_path)
    with TestClient(restarted) as client:
        home = client.get("/api/home", headers=headers).json()
        assert home["unfinished_interview"]["session_id"] == session_id
        assert home["stories"][0]["story_id"] == story_id
        assert restarted.state.interview.sessions == {}
        assert client.get(f"/api/stories/{story_id}", headers=headers).json() == detail
        restored = client.get(f"/api/interviews/{session_id}", headers=headers)
        assert restored.status_code == 200
        assert restored.json() == before
        opening.assert_called_once()
        interviewer.assert_called_once()
        continued = client.post(f"/api/interviews/{session_id}/input", headers=headers,
                                json={"text": "那时最喜欢去河边。"})
        assert continued.status_code == 200
        assert continued.json()["session_id"] == session_id
        after = client.get(f"/api/interviews/{session_id}", headers=headers).json()
        assert len(after["messages"]) == len(before["messages"]) + 2
        with psycopg.connect(guest_database) as connection:
            assert connection.execute("SELECT COUNT(*) FROM interview_sessions").fetchone()[0] == 1


def test_legacy_interview_without_topic_cannot_finish_or_lose_its_resume_entry(home_app, guest_database, monkeypatch):
    writer = Mock(side_effect=AssertionError("无章节旧会话不得成文"))
    monkeypatch.setattr("src.langgraph.node.writing.call_qwen", writer)
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        session_id = save_interview(guest_database, owner, [
            AIMessage(content="旧开场"), HumanMessage(content="小时候住在乡下。"), AIMessage(content="后来呢？"),
        ])
        response = client.post(f"/api/interviews/{session_id}/finish", headers=headers)
        assert response.status_code == 409
        with psycopg.connect(guest_database) as connection:
            assert connection.execute(
                "SELECT finish_time FROM interview_sessions WHERE id = %s", (int(session_id),),
            ).fetchone() == (None,)
            assert connection.execute("SELECT COUNT(*) FROM story WHERE user_id = %s", (owner,)).fetchone() == (0,)
        unfinished = client.get("/api/home", headers=headers).json()["unfinished_interview"]
        assert unfinished["session_id"] == session_id
        assert unfinished["needs_processing"] is False
        writer.assert_not_called()

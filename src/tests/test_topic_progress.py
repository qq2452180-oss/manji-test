"""话题入口依赖全量本人记录，并且读取进度不会恢复模型会话。"""

from unittest.mock import Mock

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage
import psycopg

from src.api.app import create_app
from src.service.story import StoryRepository
from src.tests.test_guest_auth import guest_database  # noqa: F401
from src.tests.test_home import home_app, new_user, save_interview  # noqa: F401
from src.tests.test_story_supplements import models, new_story, start_supplement, writing  # noqa: F401


def topic_session(database, owner, topic_id=1, chapter_id=1, *, finished=False):
    topic = {"id": topic_id, "chapter_id": chapter_id, "title": "保存的话题", "description": "原说明"}
    session = save_interview(database, owner, [
        AIMessage(content="请继续讲。", additional_kwargs={"interview_context": {"selected_topic": topic}}),
        HumanMessage(content="小时候门前有一条小河。"),
    ], finished=finished)
    return session, topic


def test_all_told_topics_survive_recent_five_window_and_restart(home_app, guest_database, monkeypatch, tmp_path):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        expected = {}
        for index in range(7):
            with psycopg.connect(guest_database) as connection:
                topic_id = connection.execute(
                    "INSERT INTO topic (chapter_id, title, description) VALUES (1, %s, '说明') RETURNING id",
                    (f"话题{index}",),
                ).fetchone()[0]
            session, _ = topic_session(guest_database, owner, topic_id, finished=True)
            story_id = StoryRepository(guest_database).create(
                owner, f"故事{index}", "已保存的正文", chapter_id=1, source_session_id=session,
            )
            expected[topic_id] = story_id
        restore = Mock(side_effect=AssertionError("读取首页不恢复访谈图"))
        monkeypatch.setattr(home_app.state.interview._session_manager, "_restore_session", restore)
        home = client.get("/api/home", headers=headers).json()
        assert len(home["stories"]) == 5
        assert {item["topic_id"]: item["story_id"] for item in home["topic_progress"]} == expected
        assert all(item["status"] == "told" for item in home["topic_progress"])
        restore.assert_not_called()
    with TestClient(create_app(database_url=guest_database, media_directory=tmp_path)) as client:
        assert client.get("/api/home", headers=headers).json()["topic_progress"] == home["topic_progress"]


def test_progress_distinguishes_open_session_organizing_and_readable_story(home_app, guest_database):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        session, topic = topic_session(guest_database, owner)
        progress = client.get("/api/home", headers=headers).json()["topic_progress"]
        assert progress == [{"topic_id": 1, "chapter_id": 1, "status": "in_progress",
                             "session_id": session, "story_id": None}]
        with psycopg.connect(guest_database) as connection:
            connection.execute("UPDATE interview_sessions SET finish_time = NOW() WHERE id = %s", (session,))
        assert client.get("/api/home", headers=headers).json()["topic_progress"][0]["status"] == "organizing"
        story_id = StoryRepository(guest_database).create(
            owner, "原故事", "正文已经保存，摘要尚未完成", chapter_id=1, source_session_id=session,
        )
        told = client.get("/api/home", headers=headers).json()["topic_progress"][0]
        assert told["status"] == "told"
        assert told["story_id"] == story_id
        detail = client.get(f"/api/stories/{story_id}", headers=headers).json()
        assert detail["selected_topic"] == topic
        assert detail["pending_processing"] == {"session_id": session}
        assert detail["source_sessions"] == [{"session_id": session, "kind": "original", "status": "organizing"}]


def test_topic_association_uses_owner_and_saved_snapshot_never_title(home_app, guest_database):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        other, _ = new_user(client)
        private_session, _ = topic_session(guest_database, other, finished=True)
        stories = StoryRepository(guest_database)
        private_story = stories.create(other, "保存的话题", "其他用户的故事", chapter_id=1, source_session_id=private_session)
        legacy_story = stories.create(owner, "保存的话题", "旧故事没有会话快照", chapter_id=1)
        # 旧记录即使误含他人的来源编号也不能借它推断话题或暴露问答。
        mismatched = stories.create(owner, "保存的话题", "来源不可用", chapter_id=1, source_session_id=private_session)
        assert client.get("/api/home", headers=headers).json()["topic_progress"] == []
        assert client.get(f"/api/stories/{private_story}", headers=headers).status_code == 404
        for story_id in (legacy_story, mismatched):
            detail = client.get(f"/api/stories/{story_id}", headers=headers).json()
            assert detail["selected_topic"] is None
            assert detail["body"]
            assert detail["source_sessions"] == []


def test_existing_story_remains_entry_when_another_session_starts(home_app, guest_database):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        session, _ = topic_session(guest_database, owner, finished=True)
        first = StoryRepository(guest_database).create(
            owner, "已有故事", "原正文", chapter_id=1, source_session_id=session,
        )
        topic_session(guest_database, owner)
        entry = client.get("/api/home", headers=headers).json()["topic_progress"][0]
        assert entry["status"] == "told"
        assert entry["story_id"] == first


def test_version_checked_edit_preserves_newer_story(home_app, guest_database):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        story_id = StoryRepository(guest_database).create(owner, "原题", "原文", chapter_id=1)
        url = f"/api/stories/{story_id}"
        payload = {"title": "更新", "body": "更新后的正文", "photo_layout": [], "expected_version": 1}
        assert client.patch(url, headers=headers, json=payload).status_code == 200
        assert client.patch(url, headers=headers, json={**payload, "body": "旧页面的正文"}).status_code == 409
        current = client.get(url, headers=headers).json()
        assert current["body"] == "更新后的正文"
        assert current["version"] == 2


def test_supplement_keeps_told_entry_and_exposes_the_pending_step(guest_database, models, tmp_path):
    with TestClient(create_app(database_url=guest_database, media_directory=tmp_path)) as client:
        headers, original_session, story_id = new_story(client)
        supplement = start_supplement(client, headers, story_id)
        topic = client.get("/api/home", headers=headers).json()["topic_progress"][0]
        assert topic == {"topic_id": 1, "chapter_id": 1, "status": "told",
                         "story_id": story_id, "session_id": supplement}
        url = f"/api/interviews/{supplement}"
        assert client.post(url + "/input", headers=headers, json={"text": "我还记得奶奶。"}).status_code == 200
        models.writer.return_value = writing("小时候门前有老树，我还记得奶奶。")
        models.summary.side_effect = TimeoutError("离线模拟摘要失败")
        assert client.post(url + "/finish", headers=headers).status_code == 502
        detail = client.get(f"/api/stories/{story_id}", headers=headers).json()
        assert detail["pending_processing"] == {"session_id": supplement}
        assert detail["source_sessions"] == [
            {"session_id": original_session, "kind": "original", "status": "completed"},
            {"session_id": supplement, "kind": "supplement", "status": "organizing"},
        ]
        assert client.get("/api/home", headers=headers).json()["topic_progress"][0]["status"] == "told"
        models.summary.side_effect = None
        assert client.post(url + "/finish", headers=headers).status_code == 200
        detail = client.get(f"/api/stories/{story_id}", headers=headers).json()
        assert detail["active_supplement"] is None and detail["pending_processing"] is None
        assert client.get("/api/home", headers=headers).json()["unfinished_interview"] is None

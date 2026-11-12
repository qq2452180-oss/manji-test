"""传记 MVP：真实隔离数据库中的成文、全文融合和读取。"""

import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient
import psycopg
from psycopg.rows import dict_row
import pytest

from src.api.app import create_app
from src.tests.postprocessing_support import biography_reply
from src.tests.test_guest_auth import bearer, guest_database  # noqa: F401
from src.tests.test_home import new_user, save_story


FIRST = "小时候，我常在家门口和伙伴们玩耍。"
SECOND = "后来进城工作，我跟着师傅学习木工。"


@pytest.fixture
def models(guest_database, monkeypatch):
    values = SimpleNamespace(
        interview=Mock(return_value="那时还发生过什么让您记得的事？"),
        writer=Mock(return_value=json.dumps({"title": "家门口的回忆", "body": FIRST}, ensure_ascii=False)),
        summary=Mock(return_value='{"summary":"讲述者回忆小时候在家门口和伙伴玩耍。"}'),
        merger=Mock(side_effect=biography_reply),
    )
    for path, model in (
        ("src.langgraph.node.interview.call_qwen", values.interview),
        ("src.langgraph.node.writing.call_qwen", values.writer),
        ("src.langgraph.node.summary.call_qwen", values.summary),
        ("src.service.biography.service.call_qwen", values.merger),
    ):
        monkeypatch.setattr(path, model)
    monkeypatch.setattr("src.api.app.load_rtc_provider", lambda: None)
    monkeypatch.setattr("src.api.app.load_dotenv", lambda *_args, **_kwargs: False)
    return values


def app(database, media):
    return create_app(database_url=database, media_directory=media)


def success(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def begin(client, headers, text=FIRST, *, topic_id=None):
    started = success(client.post("/api/interviews", headers=headers, json={
        "resume_mode": "text", **({"topic_id": topic_id} if topic_id else {}),
    }), 201)
    path = f"/api/interviews/{started['session_id']}"
    success(client.post(path + "/input", headers=headers, json={"text": text}))
    return path


def biography(client, headers):
    return success(client.get("/api/biography", headers=headers))


def test_global_story_updates_biography_only_on_explicit_finish_and_survives_restart(
    guest_database, models, tmp_path,
):
    with TestClient(app(guest_database, tmp_path)) as client:
        owner, headers = new_user(client)
        _, other_headers = new_user(client)
        path = begin(client, headers)
        before = success(client.get(path, headers=headers))
        assert before["status"] == "interview_replied"
        assert before["interview_scope"] == "global"
        assert biography(client, headers)["body"] is None
        models.writer.assert_not_called()
        models.merger.assert_not_called()
        with psycopg.connect(guest_database) as connection:
            assert connection.execute("SELECT COUNT(*) FROM story WHERE user_id = %s", (owner,)).fetchone() == (0,)

        result = success(client.post(path + "/finish", headers=headers))
        assert result["status"] == "completed"
        assert result["chapter_id"] is None
        assert result["interview_scope"] == "global"
        story_id = result["story_id"]
        saved = success(client.get(f"/api/stories/{story_id}", headers=headers))
        assert saved["body"] == FIRST and saved["chapter_id"] is None
        assert saved["source_sessions"][0]["status"] == "completed"
        assert saved["pending_processing"] is None
        book = biography(client, headers)
        assert book["body"] == FIRST
        assert book["chapters"] == []
        models.merger.assert_called_once()
        supplied = json.loads(models.merger.call_args.args[0][-1][1])
        assert supplied["existing_biography"] == ""
        assert supplied["story_index"] == []
        assert models.writer.call_count == 1
        home = success(client.get("/api/home", headers=headers))
        assert home["unfinished_interview"] is None
        assert [story["story_id"] for story in home["stories"]] == [story_id]
        assert client.get(f"/api/stories/{story_id}", headers=other_headers).status_code == 404
        assert biography(client, other_headers)["body"] is None

    restarted = app(guest_database, tmp_path)
    with TestClient(restarted) as client:
        restored = success(client.get(path, headers=headers))
        assert restored["status"] == "completed"
        assert restored["messages"] == before["messages"]
        assert success(client.get("/api/home", headers=headers))["unfinished_interview"] is None
        assert biography(client, headers) == book
        assert models.writer.call_count == 1
        models.merger.assert_called_once()

        following = success(client.post("/api/interviews", headers=headers, json={"resume_mode": "text"}), 201)
        state = restarted.state.interview.graph.get_state({"configurable": {"thread_id": following["session_id"]}}).values
        assert state["opening_context"] == {
            "mode": "returning_without_summary", "previous_story_id": None, "previous_story_summary": "",
        }
        memory = state["interview_context"]
        assert memory["previous_story_id"] == story_id
        assert "previous_story" not in memory
        stories = memory["life_event_context"]["stories"]
        assert [story["story_id"] for story in stories] == [story_id]
        assert stories[0]["summary"] == "讲述者回忆小时候在家门口和伙伴玩耍。"
        assert stories[0]["chapter_id"] is None and stories[0]["chapter_title"] is None


def test_chapter_and_global_stories_share_full_text_merger(
    guest_database, models, tmp_path,
):
    with TestClient(app(guest_database, tmp_path)) as client:
        _, headers = new_user(client)
        first_path = begin(client, headers, topic_id=1)
        first = success(client.post(first_path + "/finish", headers=headers))
        assert first["chapter_id"] == 1
        models.writer.return_value = json.dumps({"title": "进城学木工", "body": SECOND}, ensure_ascii=False)
        second_path = begin(client, headers, SECOND)
        second = success(client.post(second_path + "/finish", headers=headers))
        assert second["chapter_id"] is None
        assert models.merger.call_count == 2
        supplied = json.loads(models.merger.call_args.args[0][-1][1])
        assert supplied["existing_biography"] == FIRST
        assert supplied["story"]["body"] == SECOND
        book = biography(client, headers)
        assert book["body"] == FIRST + "\n\n" + SECOND
        assert [row["story_id"] for row in success(client.get("/api/chapters/1", headers=headers))["stories"]] == [first["story_id"]]


def test_failed_merge_preserves_story_and_old_book_then_retries_after_restart(
    guest_database, models, tmp_path,
):
    with TestClient(app(guest_database, tmp_path)) as client:
        owner, headers = new_user(client)
        first_path = begin(client, headers)
        success(client.post(first_path + "/finish", headers=headers))
        old_book = biography(client, headers)
        models.writer.return_value = json.dumps({"title": "进城学木工", "body": SECOND}, ensure_ascii=False)
        second_path = begin(client, headers, SECOND)
        models.merger.side_effect = RuntimeError("离线模拟融合失败")
        failed = client.post(second_path + "/finish", headers=headers)
        assert failed.status_code == 502
        assert "传记更新" in failed.json()["detail"]
        assert biography(client, headers) == old_book
        with psycopg.connect(guest_database, row_factory=dict_row) as connection:
            saved = connection.execute("SELECT * FROM story WHERE user_id = %s AND source_session_id = %s",
                                       (owner, second_path.rsplit("/", 1)[1])).fetchone()
        assert saved["body"] == SECOND

    models.merger.side_effect = biography_reply
    with TestClient(app(guest_database, tmp_path)) as client:
        result = success(client.post(second_path + "/finish", headers=headers))
        assert result["status"] == "completed" and result["story_id"] == saved["id"]
        assert biography(client, headers)["body"] == FIRST + "\n\n" + SECOND
        assert success(client.get("/api/home", headers=headers))["unfinished_interview"] is None
        assert success(client.get(f"/api/stories/{saved['id']}", headers=headers))["pending_processing"] is None
        assert models.writer.call_count == 2
        assert models.summary.call_count == 2
        assert models.merger.call_count == 3


def test_first_merge_preserves_owned_history_and_excludes_foreign_and_legacy_unassigned_stories(
    guest_database, models, tmp_path,
):
    with TestClient(app(guest_database, tmp_path)) as client:
        owner, headers = new_user(client)
        other, _ = new_user(client)
        save_story(guest_database, owner, "童年已有故事", chapter_id=1)
        save_story(guest_database, owner, "青年已有故事", chapter_id=3)
        save_story(guest_database, other, "他人的私密故事")
        save_story(guest_database, owner, "旧的无章节记录", completed=False)
        assert biography(client, headers)["body"] is None
        path = begin(client, headers)
        success(client.post(path + "/finish", headers=headers))
        supplied = json.loads(models.merger.call_args.args[0][-1][1])
        baseline = supplied["existing_biography"]
        assert baseline.index("童年已有故事") < baseline.index("青年已有故事")
        assert "他人的私密故事" not in baseline and "旧的无章节记录" not in baseline
        body = biography(client, headers)["body"]
        assert all(text in body for text in ("童年已有故事", "青年已有故事", FIRST))


def test_supplement_updates_same_story_and_biography(
    guest_database, models, tmp_path,
):
    updated = FIRST + "\n\n" + "其中一位伙伴后来和我一起进城工作。"
    with TestClient(app(guest_database, tmp_path)) as client:
        owner, headers = new_user(client)
        original_path = begin(client, headers, topic_id=1)
        original = success(client.post(original_path + "/finish", headers=headers))
        supplement = success(client.post("/api/interviews", headers=headers, json={
            "topic_id": 1, "target_story_id": original["story_id"], "resume_mode": "text",
        }), 201)
        path = f"/api/interviews/{supplement['session_id']}"
        success(client.post(path + "/input", headers=headers, json={"text": "其中一位伙伴后来和我一起进城工作。"}))
        models.writer.return_value = json.dumps({"title": "和伙伴一起长大", "body": updated}, ensure_ascii=False)
        models.merger.side_effect = None
        models.merger.return_value = json.dumps({"body": updated}, ensure_ascii=False)
        result = success(client.post(path + "/finish", headers=headers))
        assert result["story_id"] == original["story_id"]
        assert biography(client, headers)["body"] == updated
        supplied = json.loads(models.merger.call_args.args[0][-1][1])
        assert supplied["existing_biography"] == FIRST
        assert supplied["story"]["body"] == updated
        with psycopg.connect(guest_database) as connection:
            assert connection.execute("SELECT COUNT(*) FROM story WHERE user_id = %s", (owner,)).fetchone() == (1,)

    with TestClient(app(guest_database, tmp_path)) as client:
        for finished_path in (original_path, path):
            assert success(client.get(finished_path, headers=headers))["status"] == "completed"
        assert biography(client, headers)["body"] == updated
        assert models.writer.call_count == 2
        assert models.merger.call_count == 2


def test_manual_story_edit_does_not_update_biography_or_reopen_finished_processing(
    guest_database, models, tmp_path,
):
    with TestClient(app(guest_database, tmp_path)) as client:
        _, headers = new_user(client)
        path = begin(client, headers)
        result = success(client.post(path + "/finish", headers=headers))
        before = biography(client, headers)
        changed = success(client.patch(f"/api/stories/{result['story_id']}", headers=headers, json={
            "title": "用户手动修改的标题", "body": "用户手动编辑的正文。", "photo_layout": [], "expected_version": 1,
        }))
        assert changed["version"] == 2
        assert biography(client, headers) == before
        models.merger.assert_called_once()

    with TestClient(app(guest_database, tmp_path)) as client:
        assert biography(client, headers) == before
        restored = success(client.get(path, headers=headers))
        assert restored["status"] == "completed"
        assert success(client.get("/api/home", headers=headers))["unfinished_interview"] is None
        assert success(client.get(f"/api/stories/{result['story_id']}", headers=headers))["pending_processing"] is None
        models.merger.assert_called_once()

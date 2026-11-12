"""故事补充的 API 回归；使用隔离测试 schema，所有模型均离线。"""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient
import psycopg
import pytest

from src.api.app import create_app
from src.tests.test_guest_auth import guest_database  # noqa: F401
from src.tests.test_home import new_user


ORIGINAL = "小时候，我家门前有一棵老树。"
ADDITION = "夏天，奶奶常在树下给我讲故事。"
SECOND_ADDITION = "后来我离开家乡，还一直记得那片树荫。"


def writing(body):
    return json.dumps({"title": "家门前的老树", "body": body}, ensure_ascii=False)


@pytest.fixture
def models(guest_database, monkeypatch):
    values = SimpleNamespace(
        interview=Mock(return_value="那时还有什么让您记得的事？"),
        writer=Mock(return_value=writing(ORIGINAL)),
        profile=Mock(return_value='{"updates": [], "reviews": []}'),
        event=Mock(return_value=json.dumps({
            "action": "skip", "event_id": None, "title": None, "summary": None,
            "life_stage": None, "time_text": None, "status": None,
            "reason": "这次离线测试不新增经历。",
        }, ensure_ascii=False)),
        summary=Mock(return_value='{"summary":"作者记起了家门前的老树。"}'),
    )
    for path, model in (
        ("src.langgraph.node.interview.call_qwen", values.interview),
        ("src.langgraph.node.writing.call_qwen", values.writer),
        ("src.service.profile.extractor.call_qwen", values.profile),
        ("src.service.life_event.extractor.call_qwen", values.event),
        ("src.langgraph.node.summary.call_qwen", values.summary),
    ):
        monkeypatch.setattr(path, model)
    monkeypatch.setattr("src.api.app.load_rtc_provider", lambda: None)
    monkeypatch.setattr("src.api.app.load_dotenv", lambda *_args, **_kwargs: False)
    return values


def app(database, media):
    return create_app(database_url=database, media_directory=media)


def assert_success(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def new_story(client):
    _, headers = new_user(client)
    session = assert_success(client.post("/api/interviews", headers=headers, json={"topic_id": 1}), 201)
    session_id = session["session_id"]
    assert_success(client.post(f"/api/interviews/{session_id}/input", headers=headers, json={"text": ORIGINAL}))
    result = assert_success(client.post(f"/api/interviews/{session_id}/finish", headers=headers))
    assert result["status"] == "completed"
    return headers, session_id, result["story_id"]


def start_supplement(client, headers, story_id):
    response = client.post("/api/interviews", headers=headers, json={
        "topic_id": 1, "target_story_id": story_id, "resume_mode": "text",
    })
    result = assert_success(response, 201)
    assert result["target_story_id"] == story_id
    return result["session_id"]


def story_detail(client, headers, story_id):
    return assert_success(client.get(f"/api/stories/{story_id}", headers=headers))


def test_two_supplements_update_one_story_and_keep_all_original_interviews(
    guest_database, models, tmp_path,
):
    snapshots = {}
    with TestClient(app(guest_database, tmp_path)) as client:
        headers, original_session, story_id = new_story(client)
        original_story = story_detail(client, headers, story_id)
        snapshots[original_session] = assert_success(client.get(
            f"/api/interviews/{original_session}", headers=headers,
        ))["messages"]
        assert client.post(f"/api/interviews/{original_session}/input", headers=headers,
                           json={"text": "不能直接修改已结束问答"}).status_code == 409
        body = ORIGINAL
        for addition in (ADDITION, SECOND_ADDITION):
            session_id = start_supplement(client, headers, story_id)
            assert session_id not in snapshots
            assert_success(client.post(f"/api/interviews/{session_id}/input", headers=headers,
                                       json={"text": addition}))
            previous_body = body
            body += "\n\n" + addition
            models.writer.return_value = writing(body)
            result = assert_success(client.post(f"/api/interviews/{session_id}/finish", headers=headers))
            assert result["status"] == "completed" and result["story_id"] == story_id
            supplied = "\n".join(message[1] for message in models.writer.call_args.args[0])
            assert previous_body in supplied or json.dumps(previous_body, ensure_ascii=False)[1:-1] in supplied
            assert addition in supplied
            transcript = json.loads(models.writer.call_args.args[0][-1][1])
            current_session = assert_success(client.get(f"/api/interviews/{session_id}", headers=headers))
            assert transcript == {
                "format": "interview_transcript_v2",
                "messages": [{
                    "source_turn_id": message["id"], "role": message["role"], "text": message["content"],
                } for message in current_session["messages"]],
            }
            saved = story_detail(client, headers, story_id)
            assert saved["body"] == body
            assert saved["source_session_id"] == original_session
            calls = (models.writer.call_count, models.profile.call_count,
                     models.event.call_count, models.summary.call_count)
            again = assert_success(client.post(f"/api/interviews/{session_id}/finish", headers=headers))
            assert again["story_id"] == story_id
            assert story_detail(client, headers, story_id)["version"] == saved["version"]
            assert calls == (models.writer.call_count, models.profile.call_count,
                             models.event.call_count, models.summary.call_count)
            snapshots[session_id] = assert_success(client.get(
                f"/api/interviews/{session_id}", headers=headers,
            ))["messages"]
        assert saved["version"] == original_story["version"] + 2
        assert models.writer.call_count == models.profile.call_count == models.event.call_count == models.summary.call_count == 3
        assert {str(item["session_id"]) for item in saved["source_sessions"]} == set(snapshots)
        with psycopg.connect(guest_database) as connection:
            assert connection.execute("SELECT COUNT(*) FROM story").fetchone() == (1,)

    with TestClient(app(guest_database, tmp_path)) as restarted:
        for session_id, messages in snapshots.items():
            restored = assert_success(restarted.get(f"/api/interviews/{session_id}", headers=headers))
            assert restored["messages"] == messages
            assert restored["story_id"] == story_id
            assert_success(restarted.post(f"/api/interviews/{session_id}/finish", headers=headers))
        assert story_detail(restarted, headers, story_id)["body"] == body
        assert story_detail(restarted, headers, story_id)["version"] == saved["version"]
        assert models.writer.call_count == 3


def test_repeated_start_and_cold_restore_reuse_the_active_supplement(
    guest_database, models, tmp_path,
):
    with TestClient(app(guest_database, tmp_path)) as client:
        headers, _, story_id = new_story(client)
        session_id = start_supplement(client, headers, story_id)
        assert start_supplement(client, headers, story_id) == session_id
        assert_success(client.post(f"/api/interviews/{session_id}/input", headers=headers,
                                   json={"text": ADDITION}))
        saved_messages = assert_success(client.get(f"/api/interviews/{session_id}", headers=headers))["messages"]
        before = story_detail(client, headers, story_id)
        assert before["body"] == ORIGINAL
        assert str(before["active_supplement"]["session_id"]) == session_id

    interview_calls = models.interview.call_count
    with TestClient(app(guest_database, tmp_path)) as restarted:
        assert start_supplement(restarted, headers, story_id) == session_id
        restored = assert_success(restarted.get(f"/api/interviews/{session_id}", headers=headers))
        assert restored["messages"] == saved_messages
        assert restored["target_story_id"] == story_id
        assert models.interview.call_count == interview_calls
        models.writer.return_value = writing(ORIGINAL + "\n\n" + ADDITION)
        finished = assert_success(restarted.post(f"/api/interviews/{session_id}/finish", headers=headers))
        assert finished["story_id"] == story_id
        assert story_detail(restarted, headers, story_id)["active_supplement"] is None


def test_supplement_validates_owner_and_topic_before_creating_a_session(
    guest_database, models, tmp_path,
):
    with TestClient(app(guest_database, tmp_path)) as client:
        headers, _, story_id = new_story(client)
        _, other_headers = new_user(client)
        with psycopg.connect(guest_database) as connection:
            topic_id = connection.execute(
                "INSERT INTO topic (chapter_id, title, description) "
                "VALUES (1, '不同话题', '不同的讲述方向。') RETURNING id",
            ).fetchone()[0]
            count = connection.execute("SELECT COUNT(*) FROM interview_sessions").fetchone()
        for auth, topic in ((other_headers, 1), (headers, topic_id)):
            rejected = client.post("/api/interviews", headers=auth, json={
                "topic_id": topic, "target_story_id": story_id,
            })
            assert rejected.status_code == (404 if auth == other_headers else 409), rejected.text
        with psycopg.connect(guest_database) as connection:
            assert connection.execute("SELECT COUNT(*) FROM interview_sessions").fetchone() == count
        assert story_detail(client, headers, story_id)["body"] == ORIGINAL


def test_concurrent_starts_reuse_one_supplement_and_one_opening(
    guest_database, models, tmp_path,
):
    with TestClient(app(guest_database, tmp_path)) as client:
        headers, _, story_id = new_story(client)
        calls = models.interview.call_count
        ready = Barrier(2)

        def start(_):
            ready.wait(timeout=5)
            return start_supplement(client, headers, story_id)

        with ThreadPoolExecutor(max_workers=2) as executor:
            session_ids = list(executor.map(start, range(2)))
        assert len(set(session_ids)) == 1
        assert models.interview.call_count == calls + 1
        with psycopg.connect(guest_database) as connection:
            assert connection.execute("SELECT COUNT(*) FROM interview_sessions").fetchone() == (2,)


@pytest.mark.parametrize("legacy_topic", [False, True])
def test_failed_supplement_opening_can_be_retried_after_restart(
    guest_database, models, tmp_path, legacy_topic,
):
    def supplied_context():
        for role, text in models.interview.call_args.args[0]:
            for line in text.splitlines():
                if role == 'system' and line.startswith('{"interview_context":'):
                    return json.loads(line)['interview_context']
        raise AssertionError('补充开场缺少记忆材料')

    with TestClient(app(guest_database, tmp_path)) as client:
        headers, original_session, story_id = new_story(client)
        if legacy_topic:
            with psycopg.connect(guest_database) as connection:
                connection.execute(
                    "UPDATE interview_sessions SET context = jsonb_set(context, "
                    "'{0,data,additional_kwargs,interview_context,selected_topic}', "
                    "(context #> '{0,data,additional_kwargs,interview_context,selected_topic}') - 'chapter_title') "
                    "WHERE id = %s", (int(original_session),),
                )
        models.interview.side_effect = TimeoutError("离线测试模拟开场超时")
        failed = client.post("/api/interviews", headers=headers, json={
            "topic_id": 1, "target_story_id": story_id, "resume_mode": "text",
        })
        assert failed.status_code == 502, failed.text
        session_id = failed.json()["session_id"]
        expected = supplied_context()
        assert expected['selected_topic']['chapter_title']
        assert 'previous_story_id' not in expected and 'previous_story' not in expected
        assert expected['supplement_story']['body'] == ORIGINAL
        assert [story['story_id'] for story in expected['life_event_context']['stories']] == [story_id]

    models.interview.side_effect = None
    with TestClient(app(guest_database, tmp_path)) as restarted:
        restored = assert_success(restarted.get(f"/api/interviews/{session_id}", headers=headers))
        assert restored["status"] == "reply_pending" and restored["target_story_id"] == story_id
        assert_success(restarted.post(f"/api/interviews/{session_id}/retry", headers=headers))
        assert supplied_context() == expected
        state = restarted.app.state.interview.graph.get_state({'configurable': {'thread_id': session_id}}).values
        assert state['messages'][0].additional_kwargs['opening_context'] == {
            'mode': 'returning_without_summary', 'previous_story_id': None, 'previous_story_summary': '',
        }
        assert start_supplement(restarted, headers, story_id) == session_id
        with psycopg.connect(guest_database) as connection:
            assert connection.execute("SELECT COUNT(*) FROM interview_sessions").fetchone() == (2,)


@pytest.mark.parametrize("failed_stage", ["profile", "event", "summary"])
def test_supplement_postprocessing_failure_resumes_after_restart_without_reapplying_body(
    guest_database, models, tmp_path, failed_stage,
):
    with TestClient(app(guest_database, tmp_path)) as client:
        headers, _, story_id = new_story(client)
        session_id = start_supplement(client, headers, story_id)
        assert_success(client.post(f"/api/interviews/{session_id}/input", headers=headers,
                                   json={"text": ADDITION}))
        body = ORIGINAL + "\n\n" + ADDITION
        models.writer.return_value = writing(body)
        getattr(models, failed_stage).side_effect = TimeoutError("离线测试模拟处理失败")
        failed = client.post(f"/api/interviews/{session_id}/finish", headers=headers)
        assert failed.status_code == 502, failed.text
        saved = story_detail(client, headers, story_id)
        assert saved["body"] == body
        assert models.writer.call_count == 2

    getattr(models, failed_stage).side_effect = None
    models.writer.side_effect = AssertionError("已应用的补充不能再次生成正文")
    with TestClient(app(guest_database, tmp_path)) as restarted:
        result = assert_success(restarted.post(f"/api/interviews/{session_id}/finish", headers=headers))
        assert result["status"] == "completed" and result["story_id"] == story_id
        assert story_detail(restarted, headers, story_id)["version"] == saved["version"]
        assert story_detail(restarted, headers, story_id)["body"] == body
        assert models.writer.call_count == 2
        for stage in ("profile", "event", "summary"):
            assert getattr(models, stage).call_count == (3 if stage == failed_stage else 2)


def test_writing_failure_keeps_original_story_and_saved_addition_for_retry(
    guest_database, models, tmp_path,
):
    with TestClient(app(guest_database, tmp_path)) as client:
        headers, _, story_id = new_story(client)
        original = story_detail(client, headers, story_id)
        session_id = start_supplement(client, headers, story_id)
        assert_success(client.post(f"/api/interviews/{session_id}/input", headers=headers,
                                   json={"text": ADDITION}))
        models.writer.side_effect = TimeoutError("离线测试模拟整理超时")
        failed = client.post(f"/api/interviews/{session_id}/finish", headers=headers)
        assert failed.status_code == 502, failed.text
        current = story_detail(client, headers, story_id)
        assert current["body"] == original["body"] and current["version"] == original["version"]

    models.writer.side_effect = None
    models.writer.return_value = writing(ORIGINAL + "\n\n" + ADDITION)
    with TestClient(app(guest_database, tmp_path)) as restarted:
        record = assert_success(restarted.get(f"/api/interviews/{session_id}", headers=headers))
        assert any(message["content"] == ADDITION for message in record["messages"])
        assert_success(restarted.post(f"/api/interviews/{session_id}/finish", headers=headers))
        assert story_detail(restarted, headers, story_id)["version"] == original["version"] + 1


def test_conflicting_manual_edit_is_preserved_until_explicit_rebase(
    guest_database, models, tmp_path,
):
    with TestClient(app(guest_database, tmp_path)) as client:
        headers, _, story_id = new_story(client)
        initial = story_detail(client, headers, story_id)
        session_id = start_supplement(client, headers, story_id)
        assert_success(client.post(f"/api/interviews/{session_id}/input", headers=headers,
                                   json={"text": ADDITION}))
        manual_body = "我亲自改过的文字：" + ORIGINAL
        edited = assert_success(client.patch(f"/api/stories/{story_id}", headers=headers, json={
            "title": initial["title"], "body": manual_body, "photo_layout": [],
            "expected_version": initial["version"],
        }))
        models.writer.return_value = writing(ORIGINAL + "\n\n" + ADDITION)
        conflict = client.post(f"/api/interviews/{session_id}/finish", headers=headers)
        assert conflict.status_code == 409, conflict.text
        assert conflict.json()["code"] == "STORY_VERSION_CONFLICT"
        assert story_detail(client, headers, story_id)["body"] == manual_body
        assert story_detail(client, headers, story_id)["version"] == edited["version"]
        pending = assert_success(client.get(f"/api/interviews/{session_id}", headers=headers))
        assert pending["status"] == "revision_conflict"
        models.writer.return_value = writing(manual_body + "\n\n" + ADDITION)
        rebased = assert_success(client.post(f"/api/interviews/{session_id}/finish", headers=headers,
                                            json={"rebase": True}))
        assert rebased["story_id"] == story_id
        assert story_detail(client, headers, story_id)["body"] == manual_body + "\n\n" + ADDITION
        assert story_detail(client, headers, story_id)["version"] == edited["version"] + 1

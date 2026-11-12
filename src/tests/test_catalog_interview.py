"""真实数据库的目录选题、完整访谈落库和后续记忆读取；所有模型均离线。"""

import json
from unittest.mock import Mock

from fastapi.testclient import TestClient
from langchain_core.messages import HumanMessage, convert_to_messages
import psycopg
from psycopg.rows import dict_row
import pytest

from src.api.app import create_app
from src.tests.test_guest_auth import guest_database  # noqa: F401
from src.tests.test_home import new_user


@pytest.mark.parametrize("next_scope", ["chapter", "global"])
def test_database_catalog_interview_persists_and_next_visit_reads_all_saved_memory(
    guest_database, monkeypatch, tmp_path, next_scope,
):
    original = "我小时候住在乡下，家门前有一棵老树。"
    description = "数据库目录说明：早年住处的景物与生活片段。"
    summary_text = "作者讲了童年住在乡下，家门前有一棵老树。"
    with psycopg.connect(guest_database) as connection:
        chapter_id, chapter_title = connection.execute(
            "SELECT id, title FROM chapter ORDER BY sort_order, id OFFSET 1 LIMIT 1",
        ).fetchone()
        topic_id = connection.execute(
            "INSERT INTO topic (chapter_id, title, description) VALUES (%s, '住过的地方', %s) RETURNING id",
            (chapter_id, description),
        ).fetchone()[0]
        next_topic_id = connection.execute(
            "INSERT INTO topic (chapter_id, title, description, sort_order) "
            "VALUES (%s, '常走的一条路', '数据库目录说明：早年路途上的生活片段。', 1) RETURNING id",
            (chapter_id,),
        ).fetchone()[0]
    selected_topic = {
        "id": topic_id, "chapter_id": chapter_id, "chapter_title": chapter_title,
        "title": "住过的地方", "description": description,
    }
    supplied_contexts = []

    def interview_reply(messages, **_kwargs):
        converted = convert_to_messages(messages)
        for message in converted:
            if not isinstance(message.content, str):
                continue
            for line in message.content.splitlines():
                if line.startswith('{"interview_context":'):
                    supplied_contexts.append(json.loads(line)["interview_context"])
        if any(isinstance(message, HumanMessage) and message.id for message in converted):
            return "那棵老树旁边还有哪些您记得的日常？"
        return "小时候住处附近，您最先想起什么？"

    def profile_reply(messages, **_kwargs):
        profile_input = json.loads(messages[-1][1])
        user_message = next(message for message in profile_input["messages"] if message["role"] == "user")
        assert user_message["content"] == original
        return json.dumps({"updates": [{
            "field": "basic_background.growth_location", "operation": "set", "target": None,
            "value": "乡下", "evidence": "我小时候住在乡下",
            "source_message_ids": [user_message["message_id"]], "context_message_ids": [],
        }], "reviews": []}, ensure_ascii=False)

    interview_model = Mock(side_effect=interview_reply)
    writer = Mock(return_value=json.dumps({"title": "家门前的老树", "body": original}, ensure_ascii=False))
    profile_model = Mock(side_effect=profile_reply)
    event_model = Mock(return_value=json.dumps({
        "action": "create", "event_id": None, "title": "童年在乡下生活",
        "summary": "小时候住在乡下，家门前有一棵老树。", "life_stage": "童年",
        "time_text": "小时候", "status": "told", "reason": "记录了童年的一段日常生活。",
    }, ensure_ascii=False))
    summarizer = Mock(return_value=json.dumps({"summary": summary_text}, ensure_ascii=False))
    for path, model in (
        ("src.langgraph.node.interview.call_qwen", interview_model),
        ("src.langgraph.node.writing.call_qwen", writer),
        ("src.service.profile.extractor.call_qwen", profile_model),
        ("src.service.life_event.extractor.call_qwen", event_model),
        ("src.langgraph.node.summary.call_qwen", summarizer),
    ):
        monkeypatch.setattr(path, model)
    monkeypatch.setattr("src.api.app.load_rtc_provider", lambda: None)
    monkeypatch.setattr("src.api.app.load_dotenv", lambda *_args, **_kwargs: False)

    with TestClient(create_app(database_url=guest_database, media_directory=tmp_path)) as client:
        user_id, headers = new_user(client)
        catalog = client.get("/api/catalog")
        assert catalog.status_code == 200
        chapter = next(chapter for chapter in catalog.json()["chapters"] if chapter["id"] == chapter_id)
        assert next(topic for topic in chapter["topics"] if topic["id"] == topic_id) == {
            **{key: value for key, value in selected_topic.items() if key != "chapter_title"}, "sort_order": 0,
        }
        started = client.post("/api/interviews", headers=headers, json={"topic_id": topic_id, "resume_mode": "text"})
        assert started.status_code == 201
        assert started.json()["selected_topic"] == selected_topic
        assert supplied_contexts[0]["selected_topic"] == selected_topic
        assert supplied_contexts[0]["user_profile"] == {}
        assert supplied_contexts[0]["life_event_context"]["events"] == []
        assert set(supplied_contexts[0]["selected_topic"]) == {"id", "chapter_id", "chapter_title", "title", "description"}
        assert "prompt" not in supplied_contexts[0]["selected_topic"]
        assert "followups" not in supplied_contexts[0]["selected_topic"]
        session_id = started.json()["session_id"]
        path = f"/api/interviews/{session_id}"
        reply = client.post(path + "/input", headers=headers, json={"text": original})
        assert reply.status_code == 200
        assert reply.json()["selected_topic"] == selected_topic
        finished = client.post(path + "/finish", headers=headers)
        assert finished.status_code == 200
        result = finished.json()
        assert result["status"] == "completed"
        assert result["selected_topic"] == selected_topic
        assert result["chapter_id"] == chapter_id
        story_id = result["story_id"]
        story = client.get(f"/api/stories/{story_id}", headers=headers)
        assert story.status_code == 200
        assert story.json()["body"] == original
        assert story.json()["source_session_id"] == session_id
        assert story.json()["photo_layout"] == []
        before_refresh = client.get(path, headers=headers).json()
        assert len(before_refresh["messages"]) == 3

    with psycopg.connect(guest_database, row_factory=dict_row) as connection:
        stored_story = connection.execute("SELECT * FROM story WHERE id = %s", (story_id,)).fetchone()
        stored_session = connection.execute("SELECT * FROM interview_sessions WHERE id = %s", (int(session_id),)).fetchone()
        profile = connection.execute("SELECT profile_data FROM user_profiles WHERE user_id = %s", (user_id,)).fetchone()
        event = connection.execute("SELECT * FROM life_events WHERE id = %s", (stored_story["life_event_id"],)).fetchone()
        assert stored_story["user_id"] == stored_session["user_id"] == event["user_id"] == user_id
        assert stored_story["profile_processed"] is True and stored_story["life_event_processed"] is True
        assert stored_story["summary"] == summary_text
        assert stored_session["finish_time"] is not None
        saved_context = stored_session["context"][0]["data"]["additional_kwargs"]["interview_context"]
        assert saved_context["selected_topic"] == selected_topic
        assert profile["profile_data"]["basic_background"]["growth_location"] == "乡下"
        assert event["title"] == "童年在乡下生活"
        connection.execute("UPDATE topic SET is_enabled = FALSE WHERE id = %s", (topic_id,))
        older_stories = connection.execute(
            "INSERT INTO story (user_id, chapter_id, title, body, summary, create_time) "
            "SELECT %s, %s, '较早故事 ' || item, '较早故事正文', '较早故事摘要 ' || item, "
            "'2000-01-01T00:00:00+00:00' FROM generate_series(1, 6) AS item RETURNING id, title, summary",
            (user_id, chapter_id),
        ).fetchall()

    with TestClient(create_app(database_url=guest_database, media_directory=tmp_path)) as restarted:
        refreshed = restarted.get(path, headers=headers)
        assert refreshed.status_code == 200
        assert refreshed.json() == before_refresh
        assert interview_model.call_count == 2
        disabled = restarted.post("/api/interviews", headers=headers, json={"topic_id": topic_id})
        assert disabled.status_code == 422
        assert interview_model.call_count == 2
        second = restarted.post(
            "/api/interviews", headers=headers,
            json={"topic_id": next_topic_id} if next_scope == "chapter" else {},
        )
        assert second.status_code == 201
        assert second.json()["session_id"] != session_id
        memory = supplied_contexts[-1]
        if next_scope == "chapter":
            assert memory["selected_topic"]["id"] == next_topic_id
            assert memory["selected_topic"]["chapter_title"] == chapter_title
            assert memory["selected_topic"]["description"] == "数据库目录说明：早年路途上的生活片段。"
            assert "previous_story_id" not in memory
        else:
            assert memory["selected_topic"] is None
            assert memory["interview_scope"] == "global"
            assert memory["previous_story_id"] == story_id
        assert memory["user_profile"]["basic_background"]["growth_location"] == "乡下"
        assert "previous_story" not in memory
        assert memory["life_event_context"]["events"][0]["id"] == event["id"]
        stories = memory["life_event_context"]["stories"]
        assert [story["story_id"] for story in stories] == [story_id, *reversed([story["id"] for story in older_stories])]
        assert {story["story_id"]: (story["title"], story["summary"]) for story in stories} == {
            story_id: ("家门前的老树", summary_text),
            **{story["id"]: (story["title"], story["summary"]) for story in older_stories},
        }
        assert all(story["chapter_title"] == chapter_title for story in stories)
        model_text = "\n".join(message.content for message in convert_to_messages(interview_model.call_args.args[0]))
        assert model_text.count(summary_text) == 1
        assert "较早故事正文" not in model_text
        opening = next(json.loads(line)["opening_context"] for line in model_text.splitlines()
                       if line.startswith('{"opening_context":'))
        assert opening == {"mode": "returning_without_summary", "previous_story_id": None, "previous_story_summary": ""}

    assert interview_model.call_count == 3
    for model in (writer, profile_model, event_model, summarizer):
        model.assert_called_once()
    with psycopg.connect(guest_database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM interview_sessions WHERE user_id = %s", (user_id,)).fetchone() == (2,)
        assert connection.execute("SELECT COUNT(*) FROM story WHERE user_id = %s", (user_id,)).fetchone() == (7,)

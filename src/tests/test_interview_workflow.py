"""四节点工作流的真实服务入口、参考记忆和冷恢复；模型及存储均离线。"""

from copy import deepcopy
from datetime import datetime, timezone
from io import BytesIO
import json
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from langchain_core.messages import HumanMessage, convert_to_messages
from PIL import Image
import psycopg
import pytest

from src.common.dialogue.message_ids import messages_to_context
from src.langgraph.graph import build_graph
from src.langgraph.node.interview import interview_node
from src.langgraph.node.summary import _user_materials
from src.langgraph.node.writing import _build_writing_messages
from src.service.interview import InterviewError, InterviewService
from src.service.catalog import CatalogError, CatalogRepository, CatalogService
from src.service.life_event import LifeEventRepository
from src.service.profile import ProfileRepository
from src.tests.workflow_support import make_interview_flow


TOPIC_ID = 13
TOPIC = {
    "id": TOPIC_ID, "chapter_id": 2, "chapter_title": "早年生活与长大的地方", "title": "住过的地方",
    "description": "小时候住处周围的景物，以及在那里度过的日常。",
}
SUMMARY = "旧摘要专用标记：上次讲了进厂的经过。"
PROFILE = "画像专用标记：出生于河边的小村庄。"
EVENT = "经历专用标记：十八岁进厂当学徒。"


@pytest.fixture
def flow(monkeypatch):
    base = make_interview_flow(monkeypatch)
    base.history = {
        "has_story": True,
        "previous_story": {"story_id": 7, "title": "初到工厂", "summary": SUMMARY},
    }
    base.story_repository.histories[1] = base.history
    base.materials = {
        "user_profile": {"basic_background": {"birthplace": PROFILE}},
        "previous_story_id": 7,
        "life_event_context": {
            "events": [{"id": 8, "title": "进厂", "summary": EVENT}],
            "stories": [deepcopy(base.history["previous_story"])],
        },
    }
    base.inputs = Mock()
    base.inputs.build.return_value = base.materials
    base.catalog = Mock(spec=CatalogService)
    base.catalog.get_enabled_topic.side_effect = lambda topic_id: deepcopy(TOPIC) if topic_id == TOPIC_ID else None
    base.service = InterviewService(
        base.graph, base.media, base.repository,
        story_repository=base.story_repository, memory_inputs=base.inputs, catalog=base.catalog,
    )
    return base


@pytest.fixture
def biography_flow(monkeypatch):
    base = make_interview_flow(monkeypatch, with_biography=True)
    base.profiles, base.events = Mock(), Mock()

    def save_profile(user_id, session_id, *, story_id):
        story = base.stories[story_id]
        assert story["user_id"] == user_id and story["source_session_id"] == session_id
        story["profile_processed"] = True

    def save_event(user_id, story_id, *, once):
        story = base.stories[story_id]
        assert story["user_id"] == user_id and once is True
        story["life_event_processed"] = True

    base.profiles.update_profile.side_effect = save_profile
    base.events.update_life_events.side_effect = save_event

    def rebuild():
        base.graph = build_graph(
            story_repository=base.story_repository, profile_service=base.profiles,
            life_event_service=base.events,
        )
        base.service = InterviewService(
            base.graph, base.media, base.repository, story_repository=base.story_repository,
            catalog=base.catalog, biography_service=base.biography_service,
        )

    base.rebuild = rebuild
    rebuild()
    return base


@pytest.fixture
def interview_client(flow):
    from src.api.auth.dependencies import get_current_user_id
    from src.api.interview.router import interview_error, router

    app = FastAPI()
    app.state.interview = flow.service
    app.include_router(router)
    app.add_exception_handler(InterviewError, interview_error)
    app.dependency_overrides[get_current_user_id] = lambda: 1
    with TestClient(app) as client:
        yield client


def snapshot(flow, session_id):
    return flow.service.graph.get_state({"configurable": {"thread_id": session_id}})


def request_text(model):
    return "\n".join(message.content for message in convert_to_messages(model.call_args.args[0]))


def request_context(model):
    for line in request_text(model).splitlines():
        if line.startswith('{"interview_context":'):
            return json.loads(line)["interview_context"]
    raise AssertionError("模型请求缺少访谈参考记忆")


@pytest.mark.parametrize("topic_id", ["MJ2-L1-01", "13", 0, -1, True, 1.5, 2**63])
def test_api_topic_id_requires_a_positive_database_integer(flow, interview_client, topic_id):
    response = interview_client.post("/api/interviews", json={"topic_id": topic_id})
    assert response.status_code == 422
    assert flow.repository.rows == {}
    flow.catalog.get_enabled_topic.assert_not_called()
    flow.model.assert_not_called()


def test_api_requires_a_request_body_before_creating_a_session(flow, interview_client):
    response = interview_client.post("/api/interviews")
    assert response.status_code == 422
    assert flow.repository.rows == {}
    flow.catalog.get_enabled_topic.assert_not_called()
    flow.inputs.build.assert_not_called()
    flow.model.assert_not_called()


@pytest.mark.parametrize("body", [{}, {"topic_id": None}, {"resume_mode": "text"}])
def test_api_starts_a_global_interview_without_a_selected_topic(flow, interview_client, body):
    response = interview_client.post("/api/interviews", json=body)

    assert response.status_code == 201
    started = response.json()
    assert started["status"] == "awaiting_first_input"
    assert started["interview_scope"] == "global"
    assert started["selected_topic"] is None
    assert started["resume_mode"] == body.get("resume_mode")
    assert len(flow.repository.rows) == 1
    flow.catalog.get_enabled_topic.assert_not_called()
    flow.inputs.build.assert_called_once_with(1, history=flow.history)
    assert request_context(flow.model) == {
        **flow.materials, "selected_topic": None, "interview_scope": "global",
    }
    assert request_context(flow.model)["previous_story_id"] == 7
    assert request_text(flow.model).count(SUMMARY) == 1


@pytest.mark.parametrize("topic_id", ["13", 0, -1, True, 1.5, 2**63])
def test_service_rejects_an_invalid_supplied_topic_before_creating_a_session(flow, topic_id):
    with pytest.raises(InterviewError) as error:
        flow.service.start(1, topic_id=topic_id)
    assert error.value.status_code == 422
    assert flow.repository.rows == {}
    flow.catalog.get_enabled_topic.assert_not_called()
    flow.inputs.build.assert_not_called()
    flow.model.assert_not_called()


def test_supplement_still_requires_a_selected_topic(flow, interview_client):
    response = interview_client.post("/api/interviews", json={"target_story_id": 73})

    assert response.status_code == 422
    assert flow.repository.rows == {}
    flow.inputs.build.assert_not_called()
    flow.model.assert_not_called()


def test_api_missing_or_disabled_topic_and_catalog_error_do_not_create_sessions(flow, interview_client):
    unavailable = interview_client.post("/api/interviews", json={"topic_id": 999})
    assert unavailable.status_code == 422
    assert "不存在或已停用" in unavailable.json()["detail"]
    flow.catalog.get_enabled_topic.side_effect = CatalogError("话题目录暂时无法读取，请稍后重试", 503)
    failed = interview_client.post("/api/interviews", json={"topic_id": TOPIC_ID})
    assert failed.status_code == 503
    assert failed.json() == {"detail": "话题目录暂时无法读取，请稍后重试"}
    assert flow.repository.rows == {}
    flow.inputs.build.assert_not_called()
    flow.model.assert_not_called()


def test_api_failed_opening_exposes_session_for_retry_and_keeps_topic_private(flow, interview_client):
    from src.api.auth.dependencies import get_current_user_id

    flow.model.side_effect = TimeoutError("模拟首问失败")
    failed = interview_client.post("/api/interviews", json={"topic_id": TOPIC_ID})
    assert failed.status_code == 502
    session_id = failed.json()["session_id"]
    assert session_id is not None
    assert "模拟首问失败" not in failed.text
    assert interview_client.get(f"/api/interviews/{session_id}").json()["selected_topic"] == TOPIC
    interview_client.app.dependency_overrides[get_current_user_id] = lambda: 2
    denied = interview_client.get(f"/api/interviews/{session_id}")
    assert denied.status_code == 404
    assert "selected_topic" not in denied.json()
    interview_client.app.dependency_overrides[get_current_user_id] = lambda: 1
    flow.model.side_effect = None
    flow.model.return_value = "那时住处附近是什么样子？"
    retried = interview_client.post(f"/api/interviews/{session_id}/retry")
    assert retried.status_code == 200
    assert retried.json()["selected_topic"] == TOPIC
    assert len(flow.repository.rows) == 1


def test_four_node_graph_generates_one_opening_and_pauses_after_each_reply(flow):
    graph = flow.service.graph.get_graph()
    assert set(graph.nodes) == {
        "__start__", "interview", "writing", "memory_update", "summary", "__end__",
    }
    assert {(edge.source, edge.target) for edge in graph.edges} == {
        ("__start__", "interview"), ("interview", "interview"), ("interview", "writing"),
        ("writing", "memory_update"),
        ("memory_update", "summary"), ("summary", "__end__"),
    }

    result = flow.service.start(1, resume_mode="voice", topic_id=TOPIC_ID)
    session_id = result["session_id"]
    assert result["status"] == "awaiting_first_input"
    assert result["opening_text"] == "想聊哪段往事？"
    assert result["resume_mode"] == "voice"
    assert result["interview_scope"] == "chapter"
    current = snapshot(flow, session_id)
    assert current.next == ("interview",)
    assert len(current.values["messages"]) == 1
    opening = current.values["messages"][0]
    assert opening.content == result["opening_text"]
    assert opening.additional_kwargs["opening_context"] == {
        "mode": "returning_without_summary", "previous_story_id": None, "previous_story_summary": "",
    }
    expected = {**flow.materials, "selected_topic": TOPIC}
    expected.pop("previous_story_id")
    assert opening.additional_kwargs["interview_context"] == expected
    flow.model.assert_called_once()

    reply = flow.service.submit_text(1, session_id, "我小时候住在乡下。")
    assert reply["status"] == "interview_replied"
    assert reply["assistant_text"] == "后来呢？"
    assert flow.model.call_count == 2
    assert snapshot(flow, session_id).next == ("interview",)
    flow.writer.assert_not_called()
    flow.summarizer.assert_not_called()
    displayed = flow.service.get_session(1, session_id)
    assert all(set(message) == {"id", "role", "content", "image_ids"} for message in displayed["messages"])
    assert PROFILE not in json.dumps(displayed, ensure_ascii=False)


def test_selected_topic_and_memory_reach_first_and_following_questions(flow):
    started = flow.service.start(1, topic_id=TOPIC_ID)
    session_id = started["session_id"]
    assert started["selected_topic"] == TOPIC
    expected = {**deepcopy(flow.materials), "selected_topic": deepcopy(TOPIC)}
    expected.pop("previous_story_id")
    assert request_context(flow.model) == expected
    assert request_text(flow.model).count(SUMMARY) == 1
    assert set(expected["selected_topic"]) == {"id", "chapter_id", "chapter_title", "title", "description"}
    flow.story_repository.get_opening_history.assert_called_once_with(1)
    flow.inputs.build.assert_called_once()
    assert flow.inputs.build.call_args.args == (1,)
    assert flow.inputs.build.call_args.kwargs == {"history": flow.history}
    saved = deepcopy(snapshot(flow, session_id).values["messages"][0].additional_kwargs)

    flow.materials["user_profile"]["basic_background"]["birthplace"] = "调用方后来修改的画像"
    for text in ("我小时候常走一条小路。", "路边有一棵老树。"):
        response = flow.service.submit_text(1, session_id, text)
        assert response["selected_topic"] == TOPIC
        assert request_context(flow.model) == expected
        assert request_text(flow.model).count(SUMMARY) == 1
        assert all(marker in request_text(flow.model) for marker in (SUMMARY, PROFILE, EVENT))
        assert snapshot(flow, session_id).values["messages"][0].additional_kwargs == saved
    assert flow.model.call_count == 3
    flow.inputs.build.assert_called_once()
    flow.story_repository.get_opening_history.assert_called_once()
    flow.catalog.get_enabled_topic.assert_called_once_with(TOPIC_ID)
    displayed = flow.service.get_session(1, session_id)
    assert displayed["selected_topic"] == TOPIC
    assert all(marker not in json.dumps(displayed, ensure_ascii=False) for marker in (PROFILE, SUMMARY, EVENT))
    displayed["selected_topic"]["description"] = "修改响应不改变会话快照"
    assert flow.service.get_session(1, session_id)["selected_topic"] == TOPIC


@pytest.mark.parametrize("latest", [
    {"user_profile": {"basic_background": {"birthplace": "后来更正为县城"}},
     "previous_story_id": 10,
     "life_event_context": {
         "events": [{"id": 9, "title": "搬家", "summary": "后来搬到了县城。"}],
         "stories": [
             {"story_id": 7, "title": "更正后的工厂故事", "summary": "师傅教我操作机器。"},
             {"story_id": 10, "title": "搬家", "summary": "后来搬到了县城。"},
         ],
     }},
    {"user_profile": {}, "previous_story_id": None,
     "life_event_context": {"events": [], "stories": []}},
], ids=["updated", "cleared"])
def test_api_resume_replaces_memory_and_survives_cold_restore(flow, interview_client, latest):
    flow.materials["supplement_story"] = {"story_id": 7, "title": "原故事", "body": "本场补充的原稿。"}
    session_id = flow.service.start(1, topic_id=TOPIC_ID, resume_mode="voice")["session_id"]
    flow.service.submit_text(1, session_id, "我小时候常走一条小路。")
    before = flow.service.get_session(1, session_id)
    expected = deepcopy(flow.repository.rows[int(session_id)]["context"])
    expected_context = expected[0]["data"]["additional_kwargs"]["interview_context"]
    expected_context["user_profile"] = latest["user_profile"]
    expected_context["life_event_context"] = latest["life_event_context"]
    flow.inputs.build.return_value = deepcopy(latest)
    flow.model.reset_mock()
    flow.inputs.build.reset_mock()
    flow.catalog.get_enabled_topic.reset_mock()

    response = interview_client.post(f"/api/interviews/{session_id}/resume")

    assert response.status_code == 200
    assert response.json()["session_id"] == session_id
    assert len(flow.repository.rows) == 1
    assert flow.repository.rows[int(session_id)]["context"] == expected
    assert snapshot(flow, session_id).values["interview_context"] == expected_context
    assert flow.service.get_session(1, session_id) == before
    flow.inputs.build.assert_called_once_with(1)
    flow.catalog.get_enabled_topic.assert_not_called()
    flow.model.assert_not_called()

    flow.service = InterviewService(
        build_graph(story_repository=flow.story_repository), flow.media, flow.repository,
        story_repository=flow.story_repository, memory_inputs=flow.inputs, catalog=flow.catalog,
    )
    assert flow.service.get_session(1, session_id) == before
    assert snapshot(flow, session_id).values["interview_context"] == expected_context
    flow.service.submit_text(1, session_id, "路边有一棵老树。")
    assert request_context(flow.model) == expected_context
    flow.inputs.build.assert_called_once_with(1)


def test_resume_does_not_refresh_background_for_a_pending_reply(flow, interview_client):
    session_id = flow.service.start(1, topic_id=TOPIC_ID)["session_id"]
    original_context = deepcopy(request_context(flow.model))
    flow.model.side_effect = RuntimeError("模拟回复失败")
    with pytest.raises(InterviewError):
        flow.service.submit_text(1, session_id, "我小时候住在乡下。")
    saved = deepcopy(flow.repository.rows[int(session_id)]["context"])
    flow.inputs.build.reset_mock()

    response = interview_client.post(f"/api/interviews/{session_id}/resume")

    assert response.status_code == 409
    flow.inputs.build.assert_not_called()
    assert flow.repository.rows[int(session_id)]["context"] == saved
    flow.model.side_effect = None
    flow.model.return_value = "那时住处附近是什么样子？"
    flow.service.retry(1, session_id)
    assert request_context(flow.model) == original_context


def test_global_interview_keeps_memory_and_text_history_across_cold_restore(flow):
    started = flow.service.start(1, resume_mode="text")
    session_id = started["session_id"]
    expected = deepcopy(request_context(flow.model))
    assert expected == {**flow.materials, "selected_topic": None, "interview_scope": "global"}
    flow.service.submit_text(1, session_id, "我十八岁时进了工厂。")
    saved = deepcopy(flow.repository.rows[int(session_id)]["context"])
    model_calls = flow.model.call_count
    flow.inputs.build.side_effect = AssertionError("恢复全局访谈不可重新读取记忆")
    flow.story_repository.get_opening_history.side_effect = AssertionError("恢复不可重读历史")
    flow.materials["user_profile"]["basic_background"]["birthplace"] = "后来修改的画像"
    flow.service = InterviewService(
        build_graph(story_repository=flow.story_repository), flow.media, flow.repository,
        story_repository=flow.story_repository, memory_inputs=flow.inputs, catalog=flow.catalog,
    )

    restored = flow.service.get_session(1, session_id)

    assert restored["interview_scope"] == "global"
    assert restored["selected_topic"] is None
    assert restored["resume_mode"] == "text"
    assert restored["status"] == "interview_replied"
    assert [message["role"] for message in restored["messages"]] == ["assistant", "user", "assistant"]
    assert restored["messages"][1]["content"] == "我十八岁时进了工厂。"
    assert flow.model.call_count == model_calls
    assert messages_to_context(snapshot(flow, session_id).values["messages"]) == saved
    assert all(marker not in json.dumps(restored, ensure_ascii=False) for marker in (PROFILE, SUMMARY, EVENT))

    reply = flow.service.submit_text(1, session_id, "师傅先让我在旁边看。")

    assert reply["interview_scope"] == "global"
    assert reply["status"] == "interview_replied"
    assert request_context(flow.model) == expected
    assert "我十八岁时进了工厂。" in request_text(flow.model)
    assert "师傅先让我在旁边看。" in request_text(flow.model)
    assert len(flow.repository.rows[int(session_id)]["context"]) == 5
    flow.inputs.build.assert_called_once()
    flow.catalog.get_enabled_topic.assert_not_called()
    flow.writer.assert_not_called()


@pytest.mark.parametrize("first_global,next_global", [(False, False), (False, True), (True, False), (True, True)])
def test_only_first_saved_opening_is_first_use_even_without_answers_or_stories(flow, first_global, next_global):
    flow.story_repository.histories.clear()
    flow.inputs.build.return_value = {"user_profile": {}, "life_event_context": {"events": [], "stories": []}}
    other_topic = {**TOPIC, "id": TOPIC_ID + 1, "title": "常走的一条路"}
    flow.catalog.get_enabled_topic.side_effect = lambda topic_id: deepcopy(
        TOPIC if topic_id == TOPIC_ID else other_topic
    )
    first = flow.service.start(1, topic_id=None if first_global else TOPIC_ID)
    first_id = first["session_id"]
    assert snapshot(flow, first_id).values["opening_context"]["mode"] == "first"
    saved = deepcopy(flow.repository.rows[int(first_id)]["context"])
    assert flow.repository.has_user_input(1) is False
    assert flow.stories == {}

    flow.service = InterviewService(
        build_graph(story_repository=flow.story_repository), flow.media, flow.repository,
        story_repository=flow.story_repository, memory_inputs=flow.inputs, catalog=flow.catalog,
    )
    flow.service.get_session(1, first_id)
    assert flow.repository.rows[int(first_id)]["context"] == saved
    second = flow.service.start(1, topic_id=None if next_global else other_topic["id"])
    assert snapshot(flow, second["session_id"]).values["opening_context"]["mode"] == "returning_without_summary"
    assert flow.model.call_count == 2
    assert flow.repository.has_user_input(1) is False


def test_failed_first_opening_does_not_consume_intro_and_retry_notices_other_saved_opening(flow):
    flow.story_repository.histories.clear()
    flow.model.side_effect = TimeoutError("模拟首次开场失败")
    with pytest.raises(InterviewError) as failed:
        flow.service.start(1, topic_id=TOPIC_ID)
    failed_id = failed.value.session_id
    assert flow.repository.has_opening(1) is False
    original_memory = deepcopy(snapshot(flow, failed_id).values["interview_context"])

    flow.model.side_effect = None
    flow.model.return_value = "您好，我是小暖。咱们慢慢聊。"
    successful = flow.service.start(1)
    assert snapshot(flow, successful["session_id"]).values["opening_context"]["mode"] == "first"
    flow.inputs.build.side_effect = AssertionError("首问重试不重新读取记忆")
    flow.service.retry(1, failed_id)
    assert snapshot(flow, failed_id).values["messages"][0].additional_kwargs["opening_context"]["mode"] == "returning_without_summary"
    assert request_context(flow.model) == original_memory


@pytest.mark.parametrize("opening", [True, False], ids=["opening", "followup"])
def test_global_model_failure_retries_the_same_session_and_pending_input(flow, interview_client, opening):
    if not opening:
        session_id = interview_client.post("/api/interviews", json={"resume_mode": "text"}).json()["session_id"]
    flow.model.side_effect = TimeoutError("模拟模型超时")
    if opening:
        failed = interview_client.post("/api/interviews", json={"resume_mode": "text"})
        session_id = failed.json()["session_id"]
    else:
        failed = interview_client.post(f"/api/interviews/{session_id}/input", json={"text": "师傅姓周。"})
    assert failed.status_code == 502
    pending = interview_client.get(f"/api/interviews/{session_id}").json()
    assert pending["status"] == "reply_pending"
    assert pending["interview_scope"] == "global"
    flow.model.side_effect = None
    flow.model.return_value = "您平常怎么称呼他？"

    retried = interview_client.post(f"/api/interviews/{session_id}/retry")

    assert retried.status_code == 200
    assert retried.json()["interview_scope"] == "global"
    assert len(flow.repository.rows) == 1
    restored = interview_client.get(f"/api/interviews/{session_id}").json()
    assert len(restored["messages"]) == (1 if opening else 3)
    assert [message["content"] for message in restored["messages"] if message["role"] == "user"] == (
        [] if opening else ["师傅姓周。"]
    )
    flow.inputs.build.assert_called_once()
    flow.catalog.get_enabled_topic.assert_not_called()


def test_global_finish_saves_a_complete_story_without_assigning_a_chapter(flow, interview_client):
    session_id = interview_client.post("/api/interviews", json={"resume_mode": "text"}).json()["session_id"]
    interview_client.post(f"/api/interviews/{session_id}/input", json={"text": "我小时候住在乡下。"})
    saved_messages = deepcopy(flow.repository.rows[int(session_id)]["context"])

    response = interview_client.post(f"/api/interviews/{session_id}/finish")

    assert response.status_code == 200
    completed = response.json()
    assert completed["status"] == "completed"
    assert completed["interview_scope"] == "global"
    assert completed["selected_topic"] is None
    assert completed["chapter_id"] is None
    assert completed["title"] == "老家的日子"
    assert completed["body"] == "我小时候住在乡下。"
    assert flow.stories[completed["story_id"]]["chapter_id"] is None
    assert flow.repository.rows[int(session_id)]["context"] == saved_messages
    assert flow.repository.rows[int(session_id)]["finish_time"] is not None
    assert snapshot(flow, session_id).next == ()
    flow.writer.assert_called_once()
    flow.story_repository.create.assert_called_once()
    flow.story_repository.restore_chapter.assert_not_called()
    assert interview_client.post(f"/api/interviews/{session_id}/finish").json() == completed


@pytest.mark.parametrize("global_scope", [False, True], ids=["chapter", "global"])
def test_paused_interview_does_not_write_story_or_update_biography(biography_flow, global_scope):
    flow = biography_flow
    session_id = flow.service.start(1, topic_id=None if global_scope else flow.topic["id"])["session_id"]
    flow.service.submit_text(1, session_id, "我小时候住在乡下。")
    saved = deepcopy(flow.repository.rows[int(session_id)])

    # 暂停只保留当前轮次；冷恢复读取记录也不能触发成文。
    flow.rebuild()
    restored = flow.service.get_session(1, session_id)

    assert restored["status"] == "interview_replied"
    assert flow.repository.rows[int(session_id)] == saved
    assert saved["finish_time"] is None
    flow.writer.assert_not_called()
    flow.summarizer.assert_not_called()
    flow.merger.assert_not_called()
    flow.story_repository.create.assert_not_called()
    flow.biography_repository.save.assert_not_called()


@pytest.mark.parametrize("global_scope", [False, True], ids=["chapter", "global"])
def test_first_story_becomes_biography_and_completed_restore_does_not_regenerate(biography_flow, global_scope):
    flow = biography_flow
    biography_body = "一、乡下生活\n\n（一）老家的日子\n\n我小时候住在乡下。"
    flow.merger.return_value = json.dumps({"body": biography_body}, ensure_ascii=False)
    session_id = flow.service.start(1, topic_id=None if global_scope else flow.topic["id"])["session_id"]
    flow.service.submit_text(1, session_id, "我小时候住在乡下。")

    completed = flow.service.finish(1, session_id)

    assert completed["status"] == "completed"
    assert completed["chapter_id"] == (None if global_scope else flow.topic["chapter_id"])
    assert flow.biography_repository.rows[1]["body"] == biography_body
    flow.merger.assert_called_once()
    flow.profiles.update_profile.assert_called_once()
    flow.events.update_life_events.assert_called_once()
    for model in (flow.model, flow.writer, flow.summarizer, flow.merger):
        model.side_effect = AssertionError("完成后的冷恢复不得重新生成内容")
    flow.rebuild()

    restored = flow.service.get_session(1, session_id)

    assert restored["status"] == "completed"
    assert restored["story_id"] == completed["story_id"]
    assert restored["chapter_id"] == completed["chapter_id"]
    flow.story_repository.create.assert_called_once()
    flow.biography_repository.save.assert_called_once()
    flow.story_repository.restore_chapter.assert_not_called()


@pytest.mark.parametrize("global_scope", [False, True], ids=["chapter", "global"])
@pytest.mark.parametrize("cold_restore", [False, True], ids=["same-service", "restart"])
def test_failed_biography_merge_only_retries_merge(biography_flow, global_scope, cold_restore):
    flow = biography_flow
    flow.biography_repository.rows[1] = {"body": "我后来到城里学手艺。"}
    original_biography = deepcopy(flow.biography_repository.rows[1])
    flow.merger.side_effect = TimeoutError("模拟传记融合超时")
    session_id = flow.service.start(1, topic_id=None if global_scope else flow.topic["id"])["session_id"]
    flow.service.submit_text(1, session_id, "我小时候住在乡下。")

    with pytest.raises(InterviewError) as error:
        flow.service.finish(1, session_id)

    assert error.value.status_code == 502
    assert flow.biography_repository.rows[1] == original_biography
    saved_story = deepcopy(flow.stories[73])
    assert saved_story["summary"]
    assert saved_story["profile_processed"] and saved_story["life_event_processed"]
    for model in (flow.model, flow.writer, flow.summarizer):
        model.side_effect = AssertionError("融合重试不能重做已保存的访谈和成文")
    if cold_restore:
        flow.rebuild()
    assert snapshot(flow, session_id).next == ()
    flow.merger.side_effect = None

    completed = flow.service.finish(1, session_id)

    assert completed["status"] == "completed"
    assert flow.stories[73] == saved_story
    assert flow.biography_repository.rows[1]["body"] == "我小时候住在乡下，后来到城里学手艺。"
    flow.writer.assert_called_once()
    flow.summarizer.assert_called_once()
    flow.profiles.update_profile.assert_called_once()
    flow.events.update_life_events.assert_called_once()
    flow.story_repository.create.assert_called_once()
    assert flow.merger.call_count == 2


def test_null_chapter_story_without_explicit_global_scope_remains_a_legacy_record(biography_flow):
    flow = biography_flow
    session_id = flow.service.start(1)["session_id"]
    flow.service.submit_text(1, session_id, "我小时候住在乡下。")
    flow.service.finish(1, session_id)
    record = flow.repository.rows[int(session_id)]
    record["context"][0]["data"]["additional_kwargs"]["interview_context"].pop("interview_scope")
    saved = deepcopy(record)
    flow.rebuild()

    restored = flow.service.get_session(1, session_id)
    assert restored["interview_scope"] is None
    assert restored["status"] != "completed"
    with pytest.raises(InterviewError) as error:
        flow.service.finish(1, session_id)
    assert error.value.status_code == 409
    assert flow.repository.rows[int(session_id)] == saved
    flow.story_repository.create.assert_called_once()


def test_legacy_completed_story_requests_biography_without_reopening_graph(biography_flow):
    flow = biography_flow
    # 模拟升级前仅成文的服务；读取旧完成会话不应自动补做传记。
    flow.service = InterviewService(
        flow.graph, flow.media, flow.repository, story_repository=flow.story_repository,
        catalog=flow.catalog,
    )
    session_id = flow.service.start(1, topic_id=flow.topic["id"])["session_id"]
    flow.service.submit_text(1, session_id, "我小时候住在乡下。")
    story = flow.service.finish(1, session_id)
    assert story["status"] == "completed"
    flow.rebuild()

    assert flow.service.get_session(1, session_id)["status"] == "completed"
    flow.biography_repository.save.assert_not_called()
    for model in (flow.writer, flow.summarizer):
        model.side_effect = AssertionError("旧成文结果不能重新生成")

    completed = flow.service.finish(1, session_id)

    assert completed["status"] == "completed"
    assert completed["story_id"] == story["story_id"]
    assert snapshot(flow, session_id).next == ()
    assert flow.biography_repository.rows[1]["body"] == json.loads(flow.merger.return_value)["body"]
    flow.merger.assert_called_once()
    flow.biography_repository.save.assert_called_once()
    flow.writer.assert_called_once()
    flow.summarizer.assert_called_once()


def test_first_message_metadata_is_detached_in_both_directions(flow):
    memory = deepcopy(flow.materials)
    memory["selected_topic"] = deepcopy(TOPIC)
    original = deepcopy(memory)
    opening = {"mode": "recap", "previous_story_id": 7, "previous_story_summary": SUMMARY}
    result = interview_node({"opening_context": opening, "interview_context": memory})
    metadata = result["messages"][0].additional_kwargs

    memory["user_profile"]["basic_background"]["birthplace"] = "外部修改"
    memory["selected_topic"]["description"] = "外部修改的话题说明"
    opening["previous_story_summary"] = "外部改写摘要"
    assert metadata["interview_context"] == original
    assert metadata["opening_context"]["previous_story_summary"] == SUMMARY
    metadata["interview_context"]["life_event_context"]["events"].clear()
    assert memory["life_event_context"]["events"] == original["life_event_context"]["events"]


@pytest.mark.parametrize("opening", [True, False], ids=["opening", "followup"])
def test_failed_snapshot_save_retry_only_saves_existing_reply(flow, opening):
    if not opening:
        session_id = flow.service.start(1, topic_id=TOPIC_ID)["session_id"]

    def fail_completed_snapshot(user_id, session_id, context, finished=False):
        if context[-1]["type"] == "human":
            return flow.repository._save(user_id, session_id, context, finished)
        raise psycopg.OperationalError("模拟回复保存失败")

    flow.repository.save.side_effect = fail_completed_snapshot
    with pytest.raises(InterviewError) as error:
        if opening:
            flow.service.start(1, topic_id=TOPIC_ID)
        else:
            flow.service.submit_text(1, session_id, "我小时候住在乡下。")
    session_id = error.value.session_id
    assert error.value.status_code == 503 and session_id is not None
    before = deepcopy(snapshot(flow, session_id).values)
    model_calls = flow.model.call_count
    flow.model.side_effect = AssertionError("补存不可重新生成回复")
    flow.inputs.build.side_effect = AssertionError("补存不可重新读取记忆")
    flow.story_repository.get_opening_history.side_effect = AssertionError("补存不可重读历史")
    flow.repository.save.side_effect = flow.repository._save

    flow.service.retry(1, session_id)

    assert snapshot(flow, session_id).values == before
    assert flow.repository.rows[int(session_id)]["context"] == messages_to_context(before["messages"])
    assert flow.model.call_count == model_calls
    assert flow.service.get_session(1, session_id)["save_pending"] is False


@pytest.mark.parametrize("input_kind", ["voice", "text", "photo"])
@pytest.mark.parametrize("has_previous_reply", [False, True], ids=["first-input", "followup"])
def test_failed_reply_preserves_input_across_restart_and_retries_once(flow, input_kind, has_previous_reply):
    session_id = flow.service.start(1, topic_id=TOPIC_ID, resume_mode=input_kind)["session_id"]
    if has_previous_reply:
        flow.service.submit_text(1, session_id, "小时候住在乡下。")
    before = deepcopy(flow.repository.rows[int(session_id)]["context"])
    original = "老屋门前有一棵树，夏天我常在树下乘凉。"

    def fail_after_input_is_saved(*_args, **_kwargs):
        saved = flow.repository.rows[int(session_id)]["context"]
        assert saved[:-1] == before
        assert saved[-1]["type"] == "human"
        assert saved[-1]["data"]["content"] == original
        raise TimeoutError("模拟回复超时")

    flow.model.side_effect = fail_after_input_is_saved
    with pytest.raises(InterviewError) as error:
        if input_kind == "photo":
            flow.service.upload_photo(1, session_id, BytesIO(b"offline photo"), original)
        else:
            getattr(flow.service, f"submit_{input_kind}")(1, session_id, original)
    assert error.value.status_code == 502
    pending_context = deepcopy(flow.repository.rows[int(session_id)]["context"])
    pending_id = str(pending_context[-1]["data"]["id"])
    assert pending_context[-1]["data"]["additional_kwargs"]["media_ids"] == ([17] if input_kind == "photo" else [])
    flow.model.reset_mock()
    flow.inputs.build.side_effect = AssertionError("恢复不得重新加载记忆")
    flow.service = InterviewService(
        build_graph(story_repository=flow.story_repository), flow.media, flow.repository,
        story_repository=flow.story_repository, memory_inputs=flow.inputs, catalog=flow.catalog,
    )

    restored = flow.service.get_session(1, session_id)

    assert restored["status"] == "reply_pending"
    assert restored["next_node"] == "interview"
    assert restored["save_pending"] is False
    assert restored["selected_topic"] == TOPIC
    assert restored["messages"][-1] == {
        "id": pending_id, "role": "user", "content": original,
        "image_ids": [17] if input_kind == "photo" else [],
    }
    assert restored.get("assistant_text") != original
    assert messages_to_context(snapshot(flow, session_id).values["messages"]) == pending_context
    flow.model.assert_not_called()
    for operation in (
        lambda: flow.service.submit_voice(1, session_id, original),
        lambda: flow.service.finish(1, session_id),
    ):
        with pytest.raises(InterviewError) as blocked:
            operation()
        assert blocked.value.status_code == 409
    flow.model.assert_not_called()
    flow.model.side_effect = None
    flow.model.return_value = "树下乘凉的那些时候，您通常怎么过？"

    result = flow.service.retry(1, session_id)

    assert result["status"] == "interview_replied"
    flow.model.assert_called_once()
    completed = flow.repository.rows[int(session_id)]["context"]
    assert completed[:-1] == pending_context
    assert completed[-1]["type"] == "ai"
    assert completed[-1]["data"]["content"] == result["assistant_text"]
    assert sum(message["data"]["content"] == original for message in completed) == 1
    assert len({message["data"]["id"] for message in completed}) == len(completed)
    if input_kind == "photo":
        supplied = convert_to_messages(flow.model.call_args.args[0])
        assert supplied[-1].content[0] == {"type": "text", "text": original}
        assert supplied[-1].content[1]["type"] == "image_url"
    else:
        assert request_context(flow.model) == before[0]["data"]["additional_kwargs"]["interview_context"]
    with pytest.raises(InterviewError) as completed_retry:
        flow.service.retry(1, session_id)
    assert completed_retry.value.status_code == 409
    flow.model.assert_called_once()


@pytest.mark.parametrize("committed_before_error", [False, True], ids=["not-saved", "committed-then-error"])
def test_input_save_failure_skips_model_and_retry_keeps_one_input(flow, committed_before_error):
    session_id = flow.service.start(1, topic_id=TOPIC_ID, resume_mode="voice")["session_id"]
    original = "我小时候在河边长大。"
    flow.model.reset_mock()

    def fail_input_save(user_id, session_id, context, finished=False):
        if committed_before_error:
            flow.repository._save(user_id, session_id, context, finished)
        raise psycopg.OperationalError("模拟输入保存失败")

    flow.repository.save.side_effect = fail_input_save
    with pytest.raises(InterviewError) as error:
        flow.service.submit_voice(1, session_id, original)
    assert error.value.status_code == 503
    assert error.value.session_id == session_id
    flow.model.assert_not_called()
    assert flow.service.get_session(1, session_id)["save_pending"] is True
    pending_id = snapshot(flow, session_id).values["messages"][-1].id
    if committed_before_error:
        flow.service = InterviewService(
            build_graph(story_repository=flow.story_repository), flow.media, flow.repository,
            story_repository=flow.story_repository, memory_inputs=flow.inputs, catalog=flow.catalog,
        )
        assert flow.service.get_session(1, session_id)["status"] == "reply_pending"
    flow.repository.save.side_effect = flow.repository._save

    result = flow.service.retry(1, session_id)

    assert result["status"] == "interview_replied"
    flow.model.assert_called_once()
    saved = flow.repository.rows[int(session_id)]["context"]
    assert [message["type"] for message in saved] == ["ai", "human", "ai"]
    assert saved[1]["data"]["content"] == original
    assert str(saved[1]["data"]["id"]) == pending_id
    assert flow.service.get_session(1, session_id)["save_pending"] is False


def test_failed_opening_model_can_retry_the_same_session_without_creating_another(flow):
    flow.model.side_effect = TimeoutError("模拟首问超时")

    with pytest.raises(InterviewError) as error:
        flow.service.start(1, topic_id=TOPIC_ID)

    assert error.value.status_code == 502
    session_id = error.value.session_id
    assert session_id is not None
    assert list(flow.repository.rows) == [int(session_id)]
    assert flow.repository.rows[int(session_id)]["context"] == []
    pending = flow.service.get_session(1, session_id)
    assert pending["status"] == "reply_pending"
    assert pending["messages"] == []
    assert pending["selected_topic"] == TOPIC
    with pytest.raises(InterviewError) as upload_error:
        flow.service.upload_photo(1, session_id, Mock(), "等首问后再上传")
    assert upload_error.value.status_code == 409
    flow.media.upload.assert_not_called()
    flow.model.assert_called_once()
    flow.model.side_effect = None
    flow.model.return_value = "想聊哪段往事？"

    result = flow.service.retry(1, session_id)

    assert result["session_id"] == session_id
    assert result["status"] == "awaiting_first_input"
    assert result["opening_text"] == "想聊哪段往事？"
    assert list(flow.repository.rows) == [int(session_id)]
    assert len(flow.repository.rows[int(session_id)]["context"]) == 1
    assert flow.service.get_session(1, session_id)["save_pending"] is False
    assert request_context(flow.model)["selected_topic"] == deepcopy(TOPIC)
    assert flow.model.call_count == 2
    flow.inputs.build.assert_called_once()
    flow.story_repository.get_opening_history.assert_called_once()


@pytest.mark.parametrize("legacy_photo_layout", [
    [], [{"media_id": 17, "after_paragraph": 1}],
], ids=["plain", "legacy-photo-layout"])
def test_completed_session_is_immediately_completed_after_cold_restore(flow, legacy_photo_layout):
    profiles, events = Mock(), Mock()

    def save_profile(user_id, session_id, *, story_id):
        assert flow.stories[story_id]["user_id"] == user_id
        assert flow.stories[story_id]["source_session_id"] == session_id
        flow.stories[story_id]["profile_processed"] = True

    def save_event(user_id, story_id, *, once):
        assert flow.stories[story_id]["user_id"] == user_id and once is True
        flow.stories[story_id]["life_event_processed"] = True

    profiles.update_profile.side_effect = save_profile
    events.update_life_events.side_effect = save_event

    def rebuild():
        return InterviewService(
            build_graph(
                story_repository=flow.story_repository,
                profile_service=profiles, life_event_service=events,
            ),
            flow.media, flow.repository,
            story_repository=flow.story_repository, memory_inputs=flow.inputs, catalog=flow.catalog,
        )

    flow.service = rebuild()
    session_id = flow.service.start(1, topic_id=TOPIC_ID)["session_id"]
    flow.service.submit_text(1, session_id, "我小时候住在乡下。")
    completed = flow.service.finish(1, session_id)
    assert completed["status"] == "completed"
    assert completed["selected_topic"] == TOPIC
    if legacy_photo_layout:
        # 模拟已有成稿保存在数据库中的旧布局，恢复应完整返回它。
        flow.stories[completed["story_id"]]["photo_layout"] = deepcopy(legacy_photo_layout)
        completed.update(source_session_id=session_id, photo_layout=legacy_photo_layout)
    saved = deepcopy(flow.repository.rows[int(session_id)]["context"])
    models = (flow.model, flow.writer, flow.summarizer)
    call_counts = [model.call_count for model in models]
    for model in models:
        model.side_effect = AssertionError("已完成会话恢复不得再次生成")
    flow.inputs.build.side_effect = AssertionError("已完成会话恢复不得重读记忆")
    flow.service = rebuild()

    restored = flow.service.get_session(1, session_id)

    assert restored["status"] == "completed"
    assert restored["next_node"] is None
    assert restored["story_id"] == completed["story_id"]
    if legacy_photo_layout:
        assert restored["photo_layout"] == legacy_photo_layout
        assert restored["source_session_id"] == session_id
    assert flow.service.finish(1, session_id) == completed
    assert [model.call_count for model in models] == call_counts
    assert flow.repository.rows[int(session_id)]["context"] == saved
    profiles.update_profile.assert_called_once()
    events.update_life_events.assert_called_once()


@pytest.mark.parametrize("metadata_kind", ["current", "previous-memory", "missing", "legacy", "legacy-topic"])
def test_cold_restore_uses_saved_context_without_reloading_memory_or_opening(flow, metadata_kind):
    session_id = flow.service.start(1, topic_id=TOPIC_ID)["session_id"]
    flow.service.submit_text(1, session_id, "老屋门口有一棵树。")
    metadata = flow.repository.rows[int(session_id)]["context"][0]["data"]["additional_kwargs"]
    if metadata_kind == "missing":
        metadata.clear()
    elif metadata_kind == "previous-memory":
        metadata["opening_context"] = {
            "mode": "recap", "previous_story_id": 7, "previous_story_summary": SUMMARY,
        }
        metadata["interview_context"] = {
            "selected_topic": {key: value for key, value in TOPIC.items() if key != "chapter_title"},
            "previous_story": deepcopy(flow.history["previous_story"]),
            "life_event_context": {"events": [], "recent_stories": [deepcopy(flow.history["previous_story"])]},
        }
    elif metadata_kind in {"legacy", "legacy-topic"}:
        metadata.clear()
        metadata.update({
            "interview_plan": {"schema_version": 1, "goal": "旧规划专用标记"},
            "interview_context": {
                "user_profile": {"important_people": ["老周"]},
                "source_context": {"summary": "旧来源专用标记"},
            },
        })
        if metadata_kind == "legacy-topic":
            metadata["interview_context"]["selected_topic"] = {
                "id": "MJ2-L1-01", "title": "旧题卡标题", "prompt": "旧题卡开场问题",
            }
    saved = deepcopy(flow.repository.rows[int(session_id)]["context"])
    expected_context = deepcopy(metadata.get("interview_context"))
    flow.model.reset_mock()
    flow.model.side_effect = AssertionError("读取会话不可重新生成首问")
    flow.inputs.build.reset_mock()
    flow.inputs.build.side_effect = AssertionError("恢复不可重新读取记忆")
    flow.story_repository.get_opening_history.reset_mock()
    flow.story_repository.get_opening_history.side_effect = AssertionError("恢复不可重读历史")
    flow.catalog.get_enabled_topic.reset_mock()
    flow.catalog.get_enabled_topic.side_effect = AssertionError("旧会话恢复不重新读取已停用目录")
    flow.service = InterviewService(
        build_graph(story_repository=flow.story_repository), flow.media, flow.repository,
        story_repository=flow.story_repository, memory_inputs=flow.inputs, catalog=flow.catalog,
    )

    response = flow.service.get_session(1, session_id)
    expected_topic = expected_context["selected_topic"] if metadata_kind in {"current", "previous-memory"} else None
    assert response["selected_topic"] == expected_topic
    assert response["interview_scope"] == ("chapter" if expected_topic else None)

    restored = snapshot(flow, session_id)
    assert restored.next == ("interview",)
    assert messages_to_context(restored.values["messages"]) == saved
    flow.model.assert_not_called()
    flow.model.side_effect = None
    flow.model.return_value = "树下还有什么回忆？"
    flow.service.submit_text(1, session_id, "后来我经常在树下乘凉。")
    flow.model.assert_called_once()
    assert any(isinstance(message, HumanMessage) for message in convert_to_messages(flow.model.call_args.args[0]))
    if expected_context is None:
        assert '"interview_context":' not in request_text(flow.model)
    else:
        assert request_context(flow.model) == expected_context
    if metadata_kind in {"legacy", "legacy-topic"}:
        assert "旧规划专用标记" in request_text(flow.model)
        assert "旧来源专用标记" in request_text(flow.model)
    flow.inputs.build.assert_not_called()
    flow.story_repository.get_opening_history.assert_not_called()
    flow.catalog.get_enabled_topic.assert_not_called()


def test_writing_saves_the_selected_snapshot_chapter_without_reloading_catalog(flow):
    session_id = flow.service.start(1, topic_id=TOPIC_ID)["session_id"]
    flow.service.submit_text(1, session_id, "我小时候住在乡下。")
    assert "chapter_id" not in snapshot(flow, session_id).values
    flow.catalog.get_enabled_topic.side_effect = AssertionError("成文不重新读取可能已变更的目录")

    completed = flow.service.finish(1, session_id)

    assert completed["status"] == "completed"
    assert completed["chapter_id"] == TOPIC["chapter_id"]
    story = flow.stories[completed["story_id"]]
    assert story["chapter_id"] == TOPIC["chapter_id"]
    assert flow.story_repository.create.call_args.kwargs["chapter_id"] == TOPIC["chapter_id"]
    flow.story_repository.restore_chapter.assert_not_called()
    flow.writer.assert_called_once()


@pytest.mark.parametrize("saved_chapter", [None, 6], ids=["missing-chapter", "existing-chapter"])
def test_cold_restore_repairs_only_a_missing_saved_chapter_without_rewriting(flow, saved_chapter):
    session_id = flow.service.start(1, topic_id=TOPIC_ID)["session_id"]
    flow.service.submit_text(1, session_id, "我小时候住在乡下。")
    completed = flow.service.finish(1, session_id)
    story_id = completed["story_id"]
    flow.stories[story_id]["chapter_id"] = saved_chapter
    flow.stories[story_id].update(profile_processed=True, life_event_processed=True)
    original = deepcopy(flow.stories[story_id])
    flow.writer.side_effect = AssertionError("旧成稿不重写")
    flow.summarizer.side_effect = AssertionError("已保存摘要不重生成")
    flow.catalog.get_enabled_topic.side_effect = AssertionError("恢复只读取选题快照")
    flow.service = InterviewService(
        build_graph(story_repository=flow.story_repository), flow.media, flow.repository,
        story_repository=flow.story_repository, memory_inputs=flow.inputs, catalog=flow.catalog,
    )

    restored = flow.service.finish(1, session_id)

    assert restored["status"] == "completed"
    expected_chapter = TOPIC["chapter_id"] if saved_chapter is None else saved_chapter
    assert restored["chapter_id"] == expected_chapter
    assert flow.stories[story_id] == {**original, "chapter_id": expected_chapter}
    if saved_chapter is None:
        assert flow.story_repository.restore_chapter.call_count == 1
    else:
        flow.story_repository.restore_chapter.assert_not_called()
    flow.story_repository.create.assert_called_once()
    flow.writer.assert_called_once()
    flow.summarizer.assert_called_once()


def test_old_unwritten_session_without_topic_snapshot_remains_open_on_finish(flow):
    session_id = flow.service.start(1, topic_id=TOPIC_ID)["session_id"]
    flow.service.submit_text(1, session_id, "我小时候住在乡下。")
    record = flow.repository.rows[int(session_id)]
    record["context"][0]["data"]["additional_kwargs"].pop("interview_context")
    saved = deepcopy(record)
    flow.service = InterviewService(
        build_graph(story_repository=flow.story_repository), flow.media, flow.repository,
        story_repository=flow.story_repository, memory_inputs=flow.inputs, catalog=flow.catalog,
    )

    with pytest.raises(InterviewError) as error:
        flow.service.finish(1, session_id)

    assert error.value.status_code == 409
    assert flow.repository.rows[int(session_id)] == saved
    assert flow.repository.rows[int(session_id)]["finish_time"] is None
    assert snapshot(flow, session_id).next == ("interview",)
    assert not snapshot(flow, session_id).values["interview_finished"]
    flow.writer.assert_not_called()
    flow.story_repository.create.assert_not_called()


def test_writing_materials_include_ordered_dialogue_without_reference_metadata(flow):
    session_id = flow.service.start(1, topic_id=TOPIC_ID)["session_id"]
    original = "我小时候常在家门口看邻居下棋。"
    flow.service.submit_text(1, session_id, original)
    state = snapshot(flow, session_id).values
    writing = _build_writing_messages(state)

    assert [role for role, _ in writing] == ["system", "user"]
    supplied = json.loads(writing[1][1])
    assert supplied == {
        "format": "interview_transcript_v2",
        "messages": [{
            "source_turn_id": message.id,
            "role": "user" if isinstance(message, HumanMessage) else "assistant",
            "text": message.content,
        } for message in state["messages"]],
    }
    assert [message["role"] for message in supplied["messages"]] == ["assistant", "user", "assistant"]
    encoded = json.dumps(supplied, ensure_ascii=False)
    assert all(marker not in encoded for marker in (SUMMARY, PROFILE, EVENT))
    assert TOPIC["description"] not in encoded


def test_summary_materials_only_include_original_user_words(flow):
    session_id = flow.service.start(1, topic_id=TOPIC_ID)["session_id"]
    original = "我小时候常在家门口看邻居下棋。"
    flow.service.submit_text(1, session_id, original)
    state = snapshot(flow, session_id).values
    summary = _user_materials(state)

    assert [item["user_text"] for item in summary] == [original]
    encoded = json.dumps(summary, ensure_ascii=False)
    assert all(marker not in encoded for marker in (SUMMARY, PROFILE, EVENT))
    assert TOPIC["description"] not in encoded
    assert "想聊哪段往事？" not in encoded
    assert "后来呢？" not in encoded


def test_photo_interview_writes_user_words_without_layout_and_keeps_original_photo(flow, tmp_path):
    from src.api.auth.dependencies import get_current_user_id
    from src.api.interview.router import media_error, router
    from src.service.media import LocalMediaStorage, MediaRepository, MediaService
    from src.service.media.errors import MediaError

    media_rows = {}
    media_repository = Mock(spec=MediaRepository)

    def create_media(user_id, session_id, file_path):
        media_id = len(media_rows) + 1
        media_rows[media_id] = {
            "id": media_id, "user_id": user_id, "session_id": session_id, "file_path": file_path,
        }
        return media_id

    def get_media(user_id, session_id, media_id):
        row = media_rows.get(media_id)
        return row if row and (row["user_id"], row["session_id"]) == (user_id, session_id) else None

    media_repository.create.side_effect = create_media
    media_repository.get.side_effect = get_media
    media = MediaService(media_repository, LocalMediaStorage(tmp_path / "photos"))
    flow.service = InterviewService(
        build_graph(story_repository=flow.story_repository), media, flow.repository,
        story_repository=flow.story_repository, memory_inputs=flow.inputs, catalog=flow.catalog,
    )
    app = FastAPI()
    app.state.interview = flow.service
    app.state.media = media
    app.include_router(router)
    app.add_exception_handler(MediaError, media_error)
    app.dependency_overrides[get_current_user_id] = lambda: 1
    photo = BytesIO()
    Image.new("RGB", (4, 4), "blue").save(photo, format="PNG")
    photo_bytes = photo.getvalue()
    original = "这是我和家人在家门前的合影。"
    flow.writer.return_value = json.dumps({"title": "家门前的合影", "body": original}, ensure_ascii=False)

    with TestClient(app) as client:
        started = client.post("/api/interviews", json={"resume_mode": "photo", "topic_id": TOPIC_ID})
        assert started.status_code == 201
        session_id = started.json()["session_id"]
        path = f"/api/interviews/{session_id}"
        uploaded = client.post(
            path + "/photos", files={"photo": ("family.png", photo_bytes, "image/png")},
            data={"text": original},
        )
        assert uploaded.status_code == 201
        session = client.get(path).json()
        user = next(message for message in session["messages"] if message["role"] == "user")
        assert user["content"] == original and len(user["image_ids"]) == 1
        media_id = user["image_ids"][0]

        finished = client.post(path + "/finish")
        assert finished.status_code == 200
        result = finished.json()
        assert result["status"] == "completed"
        assert "photo_layout" not in result and "source_session_id" not in result
        story = flow.stories[result["story_id"]]
        assert story["photo_layout"] == []
        assert story["source_session_id"] == session_id
        assert "photo_layout" not in flow.story_repository.create.call_args.kwargs
        flow.writer.assert_called_once()
        supplied = [json.loads(text) for role, text in flow.writer.call_args.args[0] if role == "user"]
        assert supplied == [{
            "format": "interview_transcript_v2",
            "messages": [{
                "source_turn_id": message["id"], "role": message["role"], "text": message["content"],
            } for message in session["messages"]],
        }]
        assert all(set(message) == {"source_turn_id", "role", "text"} for message in supplied[0]["messages"])
        restored_photo = client.get(path + f"/photos/{media_id}")
        assert restored_photo.status_code == 200
        assert restored_photo.content == photo_bytes
        assert restored_photo.headers["content-type"] == "image/png"
        assert client.get(f"/api/interviews/999/photos/{media_id}").status_code == 404


@pytest.mark.parametrize("body", [
    {"topic_id": TOPIC_ID}, {"resume_mode": "voice", "topic_id": TOPIC_ID}, {"resume_mode": "text"},
])
def test_api_start_assembles_real_memory_service_for_topic_and_global_interviews(flow, monkeypatch, tmp_path, body):
    from src.api import app as application
    from src.api.auth.dependencies import get_current_user_id

    profiles = Mock(spec=ProfileRepository)
    profiles.get_profile.return_value = deepcopy(flow.materials["user_profile"])
    events = Mock(spec=LifeEventRepository)
    events.get_life_events.return_value = deepcopy(flow.materials["life_event_context"]["events"])
    recent_time = datetime(2026, 11, 1, tzinfo=timezone.utc)
    flow.story_repository.list_for_interview = Mock(return_value=[{
        "story_id": 7, "title": "初到工厂", "created_at": recent_time,
    }])
    catalog_repository = Mock(spec=CatalogRepository)
    catalog_repository.get_enabled_topic.side_effect = flow.catalog.get_enabled_topic
    monkeypatch.setattr(application, "CatalogRepository", Mock(return_value=catalog_repository))
    monkeypatch.setattr(application, "StoryRepository", Mock(return_value=flow.story_repository))
    monkeypatch.setattr(application, "InterviewSessionRepository", Mock(return_value=flow.repository))
    monkeypatch.setattr(application, "ProfileRepository", Mock(return_value=profiles))
    monkeypatch.setattr(application, "LifeEventRepository", Mock(return_value=events))
    monkeypatch.setattr(application, "load_dotenv", Mock(return_value=False))
    monkeypatch.setattr(application, "load_rtc_provider", lambda: None)
    app = application.create_app(database_url="unused", media_directory=tmp_path)
    app.dependency_overrides[get_current_user_id] = lambda: 1

    with TestClient(app) as client:
        response = client.post("/api/interviews", json=body)
        assert response.status_code == 201
        result = response.json()
        assert result["status"] == "awaiting_first_input"
        assert result["resume_mode"] == body.get("resume_mode")
        supplied = request_context(flow.model)
        assert supplied["user_profile"] == flow.materials["user_profile"]
        assert "previous_story" not in supplied
        assert supplied["life_event_context"]["events"] == flow.materials["life_event_context"]["events"]
        assert supplied["life_event_context"]["stories"][0]["created_at"] == recent_time.isoformat()
        if body.get("topic_id"):
            assert "previous_story_id" not in supplied
            assert supplied["selected_topic"] == deepcopy(TOPIC)
            assert result["selected_topic"] == TOPIC
            assert result["interview_scope"] == "chapter"
            catalog_repository.get_enabled_topic.assert_called_once_with(TOPIC_ID)
        else:
            assert supplied["previous_story_id"] == 7
            assert supplied["selected_topic"] is None
            assert supplied["interview_scope"] == "global"
            assert result["interview_scope"] == "global"
            catalog_repository.get_enabled_topic.assert_not_called()
        state = app.state.interview.graph.get_state({"configurable": {"thread_id": result["session_id"]}}).values
        assert state["messages"][0].additional_kwargs["interview_context"] == supplied
        before = deepcopy(flow.repository.rows)
        assert client.post("/api/interviews", json={"topic_id": "unknown-topic"}).status_code == 422
        assert flow.repository.rows == before

    profiles.get_profile.assert_called_once_with(1)
    events.get_life_events.assert_called_once_with(1)
    flow.story_repository.get_opening_history.assert_called_once_with(1)
    flow.story_repository.list_for_interview.assert_called_once_with(1)
    flow.model.assert_called_once()
    flow.inputs.build.assert_not_called()


@pytest.mark.parametrize("input_kind", ["opening", "photo", "exit"])
def test_finish_without_user_materials_keeps_session_open_for_a_later_valid_story(flow, input_kind):
    session_id = flow.service.start(1, topic_id=TOPIC_ID)["session_id"]
    if input_kind == "photo":
        flow.service.upload_photo(1, session_id, BytesIO(b"offline photo"), "")
    elif input_kind == "exit":
        flow.service.submit_text(1, session_id, "退出")
    before = deepcopy(snapshot(flow, session_id).values)
    saved = deepcopy(flow.repository.rows[int(session_id)])
    prior_status = flow.service.get_session(1, session_id)["status"]

    with pytest.raises(InterviewError) as error:
        flow.service.finish(1, session_id)

    assert error.value.status_code == 409
    current = snapshot(flow, session_id)
    assert current.next == ("interview",)
    assert current.values == before
    assert not current.values.get("interview_finished")
    assert flow.repository.rows[int(session_id)] == saved
    assert flow.repository.rows[int(session_id)]["finish_time"] is None
    assert flow.service.get_session(1, session_id)["status"] == prior_status
    assert flow.service.get_session(1, session_id)["save_pending"] is False
    flow.writer.assert_not_called()
    flow.story_repository.create.assert_not_called()

    original = "我小时候常在家门口看邻居下棋。"
    assert flow.service.submit_text(1, session_id, original)["status"] == "interview_replied"
    result = flow.service.finish(1, session_id)

    assert result["status"] == "completed"
    assert result["chapter_id"] == TOPIC["chapter_id"]
    assert flow.repository.rows[int(session_id)]["finish_time"] is not None
    flow.writer.assert_called_once()
    flow.story_repository.create.assert_called_once()
    supplied = [json.loads(text) for role, text in flow.writer.call_args.args[0] if role == "user"]
    assert len(supplied) == 1
    assert [message["text"] for message in supplied[0]["messages"] if message["role"] == "user"] == [original]

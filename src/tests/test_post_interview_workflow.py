"""真实访后服务接入图的顺序、完成标记与重试；模型和存储均离线。"""

from copy import deepcopy
import json
from unittest.mock import Mock

import pytest

from src.langgraph.graph import build_graph
from src.service.interview import InterviewError, InterviewService
from src.service.life_event import LifeEventRepository, LifeEventService
from src.service.profile import ProfileRepository, ProfileService
from src.tests.workflow_support import make_interview_flow


FLAGS = ("profile_processed", "life_event_processed")
USER_TEXT = "我小时候住在乡下。"


@pytest.fixture
def flow(monkeypatch):
    base = make_interview_flow(monkeypatch)
    base.profiles, base.events = {}, []
    base.profile_repository = Mock(spec=ProfileRepository)
    base.profile_repository.get_profile.side_effect = lambda user_id: deepcopy(base.profiles.get(user_id))

    def save_profile(user_id, profile_data, *, expected_profile, story_id=None):
        row = base.stories[story_id]
        assert row["user_id"] == user_id
        if row["profile_processed"]:
            return deepcopy(base.profiles.get(user_id, {}))
        assert base.profiles.get(user_id, {}) == expected_profile
        base.profiles[user_id] = deepcopy(profile_data)
        row["profile_processed"] = True
        return deepcopy(profile_data)

    base.profile_repository.save_profile.side_effect = save_profile
    base.event_repository = Mock(spec=LifeEventRepository)
    base.event_repository.get_life_events.side_effect = lambda user_id: deepcopy(base.events)

    def save_event(user_id, story_id, suggestion, *, once=False):
        row = base.stories[story_id]
        assert row["user_id"] == user_id and once is True
        assert not row["life_event_processed"]
        result = {**suggestion.model_dump(), "story_id": story_id}
        if suggestion.action == "create":
            event_id = len(base.events) + 81
            base.events.append({"id": event_id, **{
                key: getattr(suggestion, key)
                for key in ("title", "summary", "life_stage", "time_text", "status")
            }})
            row["life_event_id"] = event_id
            result["event_id"] = event_id
        else:
            assert suggestion.action == "skip"
        row["life_event_processed"] = True
        return result

    base.event_repository.save_suggestion.side_effect = save_event
    base.profile_service = ProfileService(base.profile_repository, base.repository)
    base.event_service = LifeEventService(base.event_repository, base.story_repository, base.profile_repository)
    monkeypatch.setattr(base.profile_service, "update_profile", Mock(wraps=base.profile_service.update_profile))
    monkeypatch.setattr(base.event_service, "update_life_events", Mock(wraps=base.event_service.update_life_events))

    def profile_reply(messages, **kwargs):
        supplied = json.loads(messages[-1][1])
        user = next(message for message in supplied["messages"] if message["role"] == "user")
        return json.dumps({"updates": [{
            "field": "basic_background.growth_location", "operation": "set", "target": None,
            "value": "乡下", "evidence": "我小时候住在乡下",
            "source_message_ids": [user["message_id"]], "context_message_ids": [],
        }], "reviews": []}, ensure_ascii=False)

    base.profile_model = Mock(side_effect=profile_reply)
    base.event_model = Mock(return_value=json.dumps({
        "action": "create", "event_id": None, "title": "小时候住在乡下",
        "summary": "小时候在乡下生活。", "life_stage": "童年", "time_text": "小时候",
        "status": "told", "reason": "本场记录了乡下生活片段。",
    }, ensure_ascii=False))
    monkeypatch.setattr("src.service.profile.extractor.call_qwen", base.profile_model)
    monkeypatch.setattr("src.service.life_event.extractor.call_qwen", base.event_model)
    base.calls = Mock()
    for name, model in (
        ("writing", base.writer), ("profile", base.profile_model),
        ("life_event", base.event_model), ("summary", base.summarizer),
    ):
        base.calls.attach_mock(model, name)
    rebuild(base)
    return base


def rebuild(flow):
    flow.service = InterviewService(
        build_graph(
            story_repository=flow.story_repository,
            profile_service=flow.profile_service, life_event_service=flow.event_service,
        ),
        flow.media, flow.repository, story_repository=flow.story_repository, catalog=flow.catalog,
    )


def begin(flow):
    session_id = flow.service.start(1, topic_id=flow.topic["id"])["session_id"]
    flow.service.submit_text(1, session_id, USER_TEXT)
    return session_id


def snapshot(flow, session_id):
    return flow.service.graph.get_state({"configurable": {"thread_id": session_id}})


def test_finish_updates_profile_before_event_extraction_and_summary(flow):
    session_id = begin(flow)
    before = deepcopy(flow.repository.rows[int(session_id)]["context"])

    result = flow.service.finish(1, session_id)

    assert result["status"] == "completed"
    assert [call[0] for call in flow.calls.mock_calls] == [
        "writing", "profile", "life_event", "summary",
    ]
    event_input = json.loads(flow.event_model.call_args.args[0][-1][1])
    assert event_input["user_profile"] == flow.profiles[1] == {"basic_background": {"growth_location": "乡下"}}
    assert event_input["story"] == {"story_id": 73, "title": result["title"], "body": result["body"]}
    profile_input = json.loads(flow.profile_model.call_args.args[0][-1][1])
    assert profile_input["current_profile"] == {}
    assert [message["content"] for message in profile_input["messages"] if message["role"] == "user"] == [USER_TEXT]
    flow.profile_service.update_profile.assert_called_once_with(1, session_id, story_id=73)
    flow.event_service.update_life_events.assert_called_once_with(1, 73, once=True)
    assert all(flow.stories[73][flag] for flag in FLAGS)
    assert flow.repository.rows[int(session_id)]["context"] == before
    assert flow.service.finish(1, session_id) == result
    assert len(flow.events) == 1
    assert len(flow.calls.mock_calls) == 4


def test_no_profile_changes_and_skipped_event_still_complete_both_steps(flow):
    flow.profile_model.side_effect = None
    flow.profile_model.return_value = '{"updates": [], "reviews": []}'
    flow.event_model.return_value = json.dumps({
        "action": "skip", "event_id": None, "title": None, "summary": None,
        "life_stage": None, "time_text": None, "status": None, "reason": "无需新增经历。",
    }, ensure_ascii=False)
    session_id = begin(flow)

    assert flow.service.finish(1, session_id)["status"] == "completed"
    assert all(flow.stories[73][flag] for flag in FLAGS)
    assert flow.profiles.get(1, {}) == {} and flow.events == []
    assert flow.service.finish(1, session_id)["status"] == "completed"
    flow.profile_model.assert_called_once()
    flow.event_model.assert_called_once()
    flow.profile_repository.save_profile.assert_called_once()
    flow.event_repository.save_suggestion.assert_called_once()


@pytest.mark.parametrize("stage", ["profile", "life_event"])
def test_failed_memory_step_remains_pending_and_finish_resumes_without_rewriting(flow, stage):
    session_id = begin(flow)
    model = flow.profile_model if stage == "profile" else flow.event_model
    normal = model.side_effect
    model.side_effect = TimeoutError("模拟更新失败")

    with pytest.raises(InterviewError) as error:
        flow.service.finish(1, session_id)

    assert error.value.status_code == 502
    assert error.value.session_id == session_id
    assert snapshot(flow, session_id).next == ("memory_update",)
    pending = flow.service.get_session(1, session_id)
    assert pending["status"] == "writing_pending" and pending["next_node"] == "memory_update"
    assert flow.stories[73]["profile_processed"] is (stage == "life_event")
    assert flow.stories[73]["life_event_processed"] is False
    flow.summarizer.assert_not_called()

    model.side_effect = normal
    assert flow.service.finish(1, session_id)["status"] == "completed"
    assert all(flow.stories[73][flag] for flag in FLAGS)
    flow.writer.assert_called_once()
    assert model.call_count == 2
    (flow.event_model if stage == "profile" else flow.profile_model).assert_called_once()
    flow.summarizer.assert_called_once()


def test_cold_restore_reuses_completed_memory_steps_after_summary_failure(flow):
    session_id = begin(flow)
    flow.summarizer.side_effect = TimeoutError("模拟摘要失败")
    with pytest.raises(InterviewError):
        flow.service.finish(1, session_id)
    assert all(flow.stories[73][flag] for flag in FLAGS)
    saved_context = deepcopy(flow.repository.rows[int(session_id)]["context"])
    flow.profile_model.side_effect = AssertionError("已完成画像不得再次提取")
    flow.event_model.side_effect = AssertionError("已完成经历不得再次归纳")
    rebuild(flow)
    flow.summarizer.side_effect = None

    assert flow.service.finish(1, session_id)["status"] == "completed"
    assert flow.repository.rows[int(session_id)]["context"] == saved_context
    flow.writer.assert_called_once()
    flow.profile_service.update_profile.assert_called_once()
    flow.event_service.update_life_events.assert_called_once()
    assert flow.summarizer.call_count == 2
    assert len(flow.events) == 1


@pytest.mark.parametrize("stage", ["profile", "life_event"])
def test_retry_after_committed_save_reads_completion_flag_without_repeating_extraction(flow, stage):
    session_id = begin(flow)
    save = (flow.profile_repository.save_profile if stage == "profile" else flow.event_repository.save_suggestion)
    commit = save.side_effect

    def commit_then_raise(*args, **kwargs):
        commit(*args, **kwargs)
        raise RuntimeError("模拟提交成功后返回失败")

    save.side_effect = commit_then_raise
    with pytest.raises(InterviewError):
        flow.service.finish(1, session_id)
    assert flow.stories[73][stage + "_processed"] is True
    assert snapshot(flow, session_id).next == ("memory_update",)
    model = flow.profile_model if stage == "profile" else flow.event_model
    model.side_effect = AssertionError("已提交步骤不得重复调用模型")

    assert flow.service.finish(1, session_id)["status"] == "completed"
    model.assert_called_once()
    save.assert_called_once()
    assert all(flow.stories[73][flag] for flag in FLAGS)
    assert len(flow.events) == 1


def test_existing_summary_cannot_hide_an_unfinished_memory_step_after_cold_restore(flow):
    session_id = begin(flow)
    normal = flow.profile_model.side_effect
    flow.profile_model.side_effect = TimeoutError("画像尚未处理")
    with pytest.raises(InterviewError):
        flow.service.finish(1, session_id)
    flow.stories[73]["summary"] = "旧版本留下的摘要。"
    rebuild(flow)

    with pytest.raises(InterviewError):
        flow.service.finish(1, session_id)
    pending = flow.service.get_session(1, session_id)
    assert pending["status"] == "writing_pending" and pending["next_node"] == "memory_update"
    assert snapshot(flow, session_id).values["summary"] == "旧版本留下的摘要。"
    assert not any(flow.stories[73][flag] for flag in FLAGS)
    flow.event_model.assert_not_called()
    flow.summarizer.assert_not_called()

    flow.profile_model.side_effect = normal
    assert flow.service.finish(1, session_id)["status"] == "completed"
    assert all(flow.stories[73][flag] for flag in FLAGS)
    assert flow.stories[73]["summary"] == "旧版本留下的摘要。"
    flow.writer.assert_called_once()
    flow.event_model.assert_called_once()
    flow.summarizer.assert_not_called()

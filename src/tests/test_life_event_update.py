"""经历归纳、校验和保存的服务流程，不调用真实模型或数据库。"""

import json
from unittest.mock import Mock

import psycopg
import pytest

from src.service.life_event import LifeEventRepository, LifeEventService, extractor
from src.service.profile.repository import ProfileRepository
from src.service.story import StoryRepository


@pytest.fixture
def update_service(monkeypatch):
    monkeypatch.setattr(psycopg, "connect", Mock(side_effect=AssertionError("不连接业务数据库")))
    repository = Mock(spec=LifeEventRepository)
    repository.get_life_events.return_value = [{
        "id": 8, "title": "第一次去北京打工", "summary": "1985年离开家乡。",
        "time_text": "1985年", "life_stage": "青年", "status": "expandable",
    }]
    stories = Mock(spec=StoryRepository)
    stories.get_for_summary.return_value = {"title": "初到北京", "body": "我去了北京，在饭店找到工作。"}
    profiles = Mock(spec=ProfileRepository)
    profiles.get_profile.return_value = None
    model = Mock()
    monkeypatch.setattr(extractor, "call_qwen", model)
    return LifeEventService(repository, stories, profiles), repository, stories, profiles, model


def suggestion(action):
    payload = {
        "action": action, "event_id": 8 if action == "update" else None,
        "title": "第一次去北京打工", "summary": "1985年离开家乡，来到北京的饭店工作。",
        "time_text": "1985年", "life_stage": "青年", "status": "expandable",
        "reason": "本次故事补充了在北京的第一份工作。",
    }
    if action == "skip":
        payload.update({key: None for key in payload if key not in {"action", "reason"}})
    return payload


@pytest.mark.parametrize("action", ["create", "update", "skip"])
def test_pipeline_reads_once_and_saves_validated_model_result(update_service, action):
    service, repository, stories, profiles, model = update_service
    payload = suggestion(action)
    model.return_value = json.dumps(payload, ensure_ascii=False)
    saved = {**payload, "story_id": 7, "event_id": 10 if action == "create" else payload["event_id"]}
    repository.save_suggestion.return_value = saved

    assert service.update_life_events(11, 7) == saved

    stories.get_for_summary.assert_called_once_with(user_id=11, story_id=7)
    repository.get_life_events.assert_called_once_with(11)
    profiles.get_profile.assert_called_once_with(11)
    model.assert_called_once()
    model_input = json.loads(model.call_args.args[0][1][1])
    assert model_input["existing_events"] == repository.get_life_events.return_value
    assert model_input["story"] == {"story_id": 7, **stories.get_for_summary.return_value}
    assert model_input["user_profile"] == {}
    repository.save_suggestion.assert_called_once()
    user_id, story_id, validated = repository.save_suggestion.call_args.args
    assert (user_id, story_id) == (11, 7)
    assert validated.model_dump() == payload
    assert payload["event_id"] == (8 if action == "update" else None)


def test_target_not_in_input_cannot_reach_database_write(update_service):
    service, repository, _, _, model = update_service
    payload = {**suggestion("update"), "event_id": 999}
    model.return_value = json.dumps(payload, ensure_ascii=False)

    with pytest.raises(ValueError, match="已有经历索引"):
        service.update_life_events(11, 7)

    repository.save_suggestion.assert_not_called()


def test_save_failure_propagates_without_retrying_model(update_service):
    service, repository, _, _, model = update_service
    model.return_value = json.dumps(suggestion("create"), ensure_ascii=False)
    failure = psycopg.OperationalError("database unavailable")
    repository.save_suggestion.side_effect = failure

    with pytest.raises(psycopg.OperationalError) as error:
        service.update_life_events(11, 7)

    assert error.value is failure
    model.assert_called_once()
    repository.save_suggestion.assert_called_once()

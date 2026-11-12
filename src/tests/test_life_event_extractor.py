"""经历归纳的输入与返回契约；不连接真实数据库或模型。"""

from copy import deepcopy
import json
from pathlib import Path
from unittest.mock import Mock

import psycopg
import pytest

from src.langgraph.prompt import prompting
from src.service.life_event import LifeEventRepository, LifeEventService, extractor
from src.service.profile.repository import ProfileRepository
from src.service.story import StoryRepository


@pytest.fixture
def extraction(monkeypatch):
    monkeypatch.setattr(psycopg, "connect", Mock(side_effect=AssertionError("不可连接真实数据库")))
    model = Mock(return_value='{"action": "skip", "reason": "无法确定经历归属"}')
    monkeypatch.setattr(extractor, "call_qwen", model)
    repository = Mock(spec=LifeEventRepository)
    stories = Mock(spec=StoryRepository)
    profiles = Mock(spec=ProfileRepository)
    stories.get_for_summary.return_value = {
        "title": "  初到北京  ", "body": '第一段。\n\n他说：“慢慢来。”\n', "summary": "故事摘要",
    }
    repository.get_life_events.return_value = []
    profiles.get_profile.return_value = None
    service = LifeEventService(repository, stories, profiles)
    return service, repository, stories, profiles, model


@pytest.mark.parametrize("has_context", [False, True])
def test_extract_sends_complete_story_events_and_profile_and_returns_suggestion(extraction, has_context):
    service, repository, stories, profiles, model = extraction
    if has_context:
        repository.get_life_events.return_value = [{
            "id": 8, "title": "第一次去北京打工", "summary": "1985年离开家乡。",
            "time_text": "1985年", "life_stage": "青年", "status": "expandable",
        }]
        profiles.get_profile.return_value = {"basic_background": {"birth_year": 1965}}
    story = deepcopy(stories.get_for_summary.return_value)
    events = deepcopy(repository.get_life_events.return_value)
    profile = deepcopy(profiles.get_profile.return_value)
    suggestion = {
        "action": "update" if has_context else "create", "event_id": 8 if has_context else None,
        "title": "第一次去北京打工", "summary": "离开家乡后在北京找到第一份工作。",
        "life_stage": "青年", "time_text": "1985年" if has_context else None,
        "status": "expandable", "reason": "本次故事讲述打工的开端。",
    }
    model.return_value = json.dumps(suggestion, ensure_ascii=False)

    assert service.extract_life_event_updates(11, 7) == suggestion

    model.assert_called_once()
    request = model.call_args.args[0]
    prompt_path = Path(__file__).resolve().parents[1] / "langgraph/prompt/event/life_event.md"
    assert request[0] == ("system", prompt_path.read_text(encoding="utf-8").strip())
    assert len(request) == 2 and request[1][0] == "user"
    assert json.loads(request[1][1]) == {
        "story": {"story_id": 7, "title": story["title"], "body": story["body"]},
        "existing_events": events,
        "user_profile": profile or {},
    }
    assert "初到北京" in request[1][1]
    assert model.call_args.kwargs == {"json_output": True}
    stories.get_for_summary.assert_called_once_with(user_id=11, story_id=7)
    repository.get_life_events.assert_called_once_with(11)
    profiles.get_profile.assert_called_once_with(11)
    profiles.save_profile.assert_not_called()
    assert stories.get_for_summary.return_value == story
    assert repository.get_life_events.return_value == events
    assert profiles.get_profile.return_value == profile


def test_missing_story_stops_before_loading_context_or_calling_model(extraction):
    service, repository, stories, profiles, model = extraction
    stories.get_for_summary.return_value = None

    with pytest.raises(ValueError, match="未找到该用户的故事"):
        service.extract_life_event_updates(11, 99)

    stories.get_for_summary.assert_called_once_with(user_id=11, story_id=99)
    repository.get_life_events.assert_not_called()
    profiles.get_profile.assert_not_called()
    model.assert_not_called()


@pytest.mark.parametrize("raw, error_type", [
    ('{"action":', json.JSONDecodeError),
    ('```json\n{"action":"skip"}\n```', json.JSONDecodeError),
    ('null', ValueError),
    ('[]', ValueError),
    ('"skip"', ValueError),
])
def test_invalid_model_return_fails_instead_of_becoming_skip(extraction, raw, error_type):
    service, _, _, _, model = extraction
    model.return_value = raw
    with pytest.raises(error_type):
        service.extract_life_event_updates(11, 7)
    model.assert_called_once()


@pytest.mark.parametrize("source", ["story", "events", "profile", "model"])
def test_loading_or_model_failure_propagates(extraction, source):
    service, repository, stories, profiles, model = extraction
    failure = RuntimeError("upstream unavailable")
    targets = {
        "story": stories.get_for_summary, "events": repository.get_life_events,
        "profile": profiles.get_profile, "model": model,
    }
    targets[source].side_effect = failure
    with pytest.raises(RuntimeError) as error:
        service.extract_life_event_updates(11, 7)
    assert error.value is failure
    if source != "model":
        model.assert_not_called()


@pytest.mark.parametrize("prompt_exists", [False, True])
def test_missing_or_empty_prompt_stops_model_call(extraction, monkeypatch, tmp_path, prompt_exists):
    service, _, _, _, model = extraction
    monkeypatch.setattr(prompting, "PROMPT_DIR", tmp_path)
    event_dir = tmp_path / "event"
    event_dir.mkdir()
    if prompt_exists:
        (event_dir / "life_event.md").write_text(" \n", encoding="utf-8")
    with pytest.raises(ValueError if prompt_exists else FileNotFoundError):
        service.extract_life_event_updates(11, 7)
    model.assert_not_called()

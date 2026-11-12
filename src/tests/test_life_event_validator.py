"""验证模型建议的基本边界，不连接数据库或调用模型。"""

from copy import deepcopy

import pytest

from src.service.life_event.schema import LifeEventSuggestion
from src.service.life_event.validator import validate_life_event_suggestion


def suggestion(action="create", **changes):
    result = {
        "action": action,
        "event_id": 7 if action == "update" else None,
        "title": "第一次去北京打工",
        "summary": "1985 年来到北京，在饭店找到第一份工作。",
        "life_stage": "青年",
        "time_text": "1985年",
        "status": "expandable",
        "reason": "故事讲述了这段打工经历。",
    }
    if action == "skip":
        result.update({key: None for key in result if key not in {"action", "reason"}})
    return {**result, **changes}


@pytest.mark.parametrize("action", ["create", "update", "skip"])
def test_valid_suggestions_preserve_input_and_return_model(action):
    payload = suggestion(action)
    events = [{"id": 7, "title": "第一次去北京打工"}]
    original = deepcopy((payload, events))

    result = validate_life_event_suggestion(payload, events)

    assert isinstance(result, LifeEventSuggestion)
    assert result.model_dump() == payload
    assert (payload, events) == original


@pytest.mark.parametrize("event_id", [None, 0, -1, 8, True, "7", 7.0])
def test_update_rejects_missing_unknown_or_non_integer_target(event_id):
    with pytest.raises(ValueError):
        validate_life_event_suggestion(suggestion("update", event_id=event_id), [{"id": 7}])


def test_create_cannot_supply_an_existing_event_id():
    with pytest.raises(ValueError):
        validate_life_event_suggestion(suggestion(event_id=7), [{"id": 7}])


@pytest.mark.parametrize("field,value", [
    ("event_id", 7), ("title", "已有经历"), ("summary", "已有摘要"),
    ("life_stage", "未知"), ("time_text", "1985年"), ("status", "told"),
])
def test_skip_cannot_carry_write_fields(field, value):
    with pytest.raises(ValueError):
        validate_life_event_suggestion(suggestion("skip", **{field: value}), [{"id": 7}])


@pytest.mark.parametrize("changes", [
    {"title": None}, {"title": " \n"}, {"title": "字" * 201},
    {"summary": None}, {"summary": " \n"}, {"summary": 123},
    {"life_stage": None}, {"life_stage": "成年"},
    {"status": None}, {"status": "pending"},
    {"time_text": " \n"}, {"time_text": "字" * 101},
])
def test_write_fields_reject_invalid_values(changes):
    with pytest.raises(ValueError):
        validate_life_event_suggestion(suggestion(**changes), [])


@pytest.mark.parametrize("time_text", [None, "字" * 100])
def test_storage_limits_and_unknown_time_are_accepted(time_text):
    payload = suggestion(title="字" * 200, time_text=time_text, life_stage="未知", status="told")
    assert validate_life_event_suggestion(payload, []).model_dump() == payload


@pytest.mark.parametrize("action", ["create", "update", "skip"])
def test_every_action_requires_a_nonblank_reason(action):
    with pytest.raises(ValueError):
        validate_life_event_suggestion(suggestion(action, reason=" \n"), [{"id": 7}])


@pytest.mark.parametrize("changes", [
    {"action": "delete"}, {"start_date": None}, {"end_date": "1985-01-01"},
    {"reason": None},
])
def test_unexpected_contract_fields_and_actions_are_rejected(changes):
    with pytest.raises(ValueError):
        validate_life_event_suggestion(suggestion(**changes), [])


def test_all_contract_fields_are_required_even_when_nullable():
    payload = suggestion()
    del payload["time_text"]
    with pytest.raises(ValueError):
        validate_life_event_suggestion(payload, [])

"""画像更新的业务编排；不调用真实模型或业务数据库。"""

from copy import deepcopy
import json
from unittest.mock import Mock

import psycopg
from psycopg.types.json import Jsonb
import pytest

from src.service.interview.repository import InterviewSessionRepository
from src.service.profile import ProfileRepository, ProfileService, extractor
from src.tests.test_profile_repository import profile_database  # noqa: F401


@pytest.fixture
def update_service(monkeypatch):
    monkeypatch.setattr(psycopg, "connect", Mock(side_effect=AssertionError("不连接业务数据库")))
    repository = Mock(spec=ProfileRepository)
    repository.get_profile.return_value = None
    repository.save_profile.side_effect = lambda user_id, profile, **kwargs: profile
    interviews = Mock(spec=InterviewSessionRepository)
    interviews.get.return_value = {"context": [
        {"type": "ai", "data": {"id": "q1", "content": "您现在住哪里？"}},
        {"type": "human", "data": {"id": "a1", "content": "我现在住杭州。"}},
    ]}
    model = Mock(return_value={"updates": [{
        "field": "basic_background.current_location", "operation": "set",
        "target": None, "value": "杭州", "evidence": "我现在住杭州",
        "source_message_ids": ["a1"], "context_message_ids": ["q1"],
    }], "reviews": []})
    monkeypatch.setattr(extractor, "extract_profile_updates", model)
    return ProfileService(repository, interviews), repository, interviews, model


def test_extract_merge_and_save_use_one_profile_snapshot(update_service):
    service, repository, interviews, model = update_service
    old_profile = {"family_background": {"siblings_count": 0}}
    repository.get_profile.return_value = old_profile
    original = deepcopy(old_profile)

    result = service.update_profile(11, "7")

    assert result["profile"] == {
        "family_background": {"siblings_count": 0},
        "basic_background": {"current_location": "杭州"},
    }
    assert result["reviews"] == []
    repository.get_profile.assert_called_once_with(11)
    interviews.get.assert_called_once_with(11, 7)
    repository.save_profile.assert_called_once_with(11, result["profile"], expected_profile=original)
    assert model.call_args.args[0]["current_profile"] == original
    assert old_profile == original


def test_reviews_are_returned_without_creating_or_updating_profile(update_service):
    service, repository, _, model = update_service
    review = {
        "field": "basic_background.current_location", "existing_value": None,
        "new_value": "杭州", "reason": "需要核实", "evidence": "我现在住杭州",
        "source_message_ids": ["a1"], "context_message_ids": [],
    }
    model.return_value = {"updates": [], "reviews": [review]}

    assert service.update_profile(11, 7) == {"profile": {}, "updates": [], "reviews": [review]}
    repository.save_profile.assert_not_called()


def test_invalid_later_update_does_not_save_earlier_updates(update_service):
    service, repository, _, model = update_service
    invalid = deepcopy(model.return_value["updates"][0])
    invalid["source_message_ids"] = ["not-a-real-message"]
    model.return_value["updates"].append(invalid)

    with pytest.raises(ValueError):
        service.update_profile(11, 7)

    repository.save_profile.assert_not_called()


def test_unchanged_profile_does_not_refresh_database_timestamp(update_service):
    service, repository, _, model = update_service
    repository.get_profile.return_value = {"basic_background": {"current_location": "杭州"}}
    model.return_value = {"updates": [], "reviews": []}

    result = service.update_profile(11, 7)

    assert result["profile"] == repository.get_profile.return_value
    repository.save_profile.assert_not_called()


def test_concurrent_save_conflict_propagates_without_retrying_model(update_service):
    service, repository, _, model = update_service
    conflict = ValueError("画像已变化，请重新提取后再保存")
    repository.save_profile.side_effect = conflict

    with pytest.raises(ValueError) as error:
        service.update_profile(11, 7)

    assert error.value is conflict
    model.assert_called_once()
    repository.save_profile.assert_called_once()


def test_read_extract_merge_save_pipeline_in_isolated_database(profile_database, monkeypatch):
    context = [
        {"type": "ai", "data": {"id": 1, "content": "您现在住哪里？"}},
        {"type": "human", "data": {"id": 2, "content": "我现在住杭州。"}},
    ]
    with psycopg.connect(profile_database) as connection:
        connection.execute(
            "INSERT INTO interview_sessions (id, user_id, context) "
            "OVERRIDING SYSTEM VALUE VALUES (7, 1, %s)", (Jsonb(context),),
        )

    suggestion = {
        "field": "basic_background.current_location", "operation": "set",
        "target": None, "value": "杭州", "evidence": "我现在住杭州",
        "source_message_ids": ["2"], "context_message_ids": ["1"],
    }
    model = Mock(return_value=json.dumps({"updates": [suggestion], "reviews": []}, ensure_ascii=False))
    monkeypatch.setattr(extractor, "call_qwen", model)
    repository = ProfileRepository(profile_database)
    service = ProfileService(repository, InterviewSessionRepository(profile_database))

    first = service.update_profile(1, "7")
    assert first["profile"] == repository.get_profile(1) == {
        "basic_background": {"current_location": "杭州"},
    }

    context.append({"type": "human", "data": {"id": 3, "content": "后来搬到了南京，现在住南京。"}})
    with psycopg.connect(profile_database) as connection:
        connection.execute("UPDATE interview_sessions SET context = %s WHERE id = 7", (Jsonb(context),))
    suggestion.update(
        operation="replace", target="杭州", value="南京", evidence="现在住南京",
        source_message_ids=["3"], context_message_ids=[],
    )
    model.return_value = json.dumps({"updates": [suggestion], "reviews": []}, ensure_ascii=False)

    second = service.update_profile(1, 7)
    assert second["profile"] == repository.get_profile(1) == {
        "basic_background": {"current_location": "南京"},
    }
    request_payload = json.loads(model.call_args.args[0][1][1])
    assert request_payload["current_profile"] == first["profile"]
    assert repository.get_profile(2) is None

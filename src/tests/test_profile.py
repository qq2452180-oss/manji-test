"""画像提示词输入组装；不连接数据库或调用模型。"""

from copy import deepcopy
import json
from unittest.mock import MagicMock, Mock

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, messages_to_dict
import psycopg
import pytest

from src.service.interview.repository import InterviewSessionRepository
from src.service.profile import ProfileRepository, ProfileService
from src.service.profile.validator import apply_profile_updates


@pytest.fixture(autouse=True)
def no_database_connections(monkeypatch):
    monkeypatch.setattr(psycopg, "connect", Mock(side_effect=AssertionError("测试不可连接数据库")))


@pytest.fixture
def profile():
    repository = Mock(spec=ProfileRepository)
    interviews = Mock(spec=InterviewSessionRepository)
    return ProfileService(repository, interviews), repository, interviews


def save_context(interviews, messages):
    context = messages_to_dict(messages)
    interviews.get.return_value = {"id": 7, "user_id": 11, "context": context}
    return context


@pytest.mark.parametrize("stored", [None, {}, {"name": "张三", "birth": {"year": 1950}}])
def test_profile_returns_empty_object_when_missing(profile, stored):
    service, repository, interviews = profile
    repository.get_profile.return_value = stored
    assert service.get_profile(11) == (stored if stored is not None else {})
    repository.get_profile.assert_called_once_with(11)
    interviews.get.assert_not_called()


def test_messages_preserve_original_text_order_ids_and_unanswered_tail(profile):
    service, repository, interviews = profile
    context = save_context(interviews, [
        AIMessage(content="您出生在哪里？", id="q1"),
        HumanMessage(content="  扬州。\n", id="a1"),
        AIMessage(content="后来在哪里上学？", id="q2"),
        HumanMessage(content="在村里的小学。", id="a2"),
        AIMessage(content="还记得老师吗？", id="unanswered"),
    ])
    original = deepcopy(context)
    assert service.get_session_messages(11, "7") == [
        {"message_id": "q1", "role": "assistant", "content": "您出生在哪里？"},
        {"message_id": "a1", "role": "user", "content": "  扬州。\n"},
        {"message_id": "q2", "role": "assistant", "content": "后来在哪里上学？"},
        {"message_id": "a2", "role": "user", "content": "在村里的小学。"},
        {"message_id": "unanswered", "role": "assistant", "content": "还记得老师吗？"},
    ]
    interviews.get.assert_called_once_with(11, 7)
    repository.get_profile.assert_not_called()
    assert context == original


def test_numeric_context_ids_are_available_as_profile_evidence(profile):
    service, _, interviews = profile
    interviews.get.return_value = {"context": [
        {"type": "human", "data": {"id": 9223372036854775807, "content": "现在住杭州"}},
    ]}
    messages = service.get_session_messages(11, 7)
    assert messages[0]["message_id"] == "9223372036854775807"
    result = apply_profile_updates({}, {"updates": [{
        "field": "basic_background.current_location", "operation": "set", "target": None,
        "value": "杭州", "evidence": "现在住杭州",
        "source_message_ids": ["9223372036854775807"], "context_message_ids": [],
    }], "reviews": []}, messages)
    assert result["profile"]["basic_background"]["current_location"] == "杭州"


def test_consecutive_ai_messages_are_kept_without_extra_resume_metadata(profile):
    service, _, interviews = profile
    save_context(interviews, [
        AIMessage(content="您在哪里工作？", id="q1"),
        HumanMessage(content="在学校。", id="a1"),
        AIMessage(content="是哪所学校？", id="old-follow-up"),
        AIMessage(content="您可以接着讲学校的事情。", id="resume", additional_kwargs={
            "kind": "resume_opening", "summary": "模型生成的回顾，不能当作用户原话。",
        }),
        HumanMessage(content="我教数学。", id="a2"),
    ])
    messages = service.get_session_messages(11, 7)
    assert [message["message_id"] for message in messages] == [
        "q1", "a1", "old-follow-up", "resume", "a2",
    ]
    assert [message["role"] for message in messages] == [
        "assistant", "user", "assistant", "assistant", "user",
    ]
    assert messages[3] == {
        "message_id": "resume", "role": "assistant", "content": "您可以接着讲学校的事情。",
    }


def test_orphan_and_consecutive_user_messages_keep_their_original_order(profile):
    service, _, interviews = profile
    save_context(interviews, [
        HumanMessage(content="我先补充一句。"),
        SystemMessage(content="内部背景，不是访谈提问。"),
        AIMessage(content="请继续说。", id="q"),
        HumanMessage(content="第一部分。", id="a1"),
        HumanMessage(content="还有第二部分。", id="a2"),
    ])
    messages = service.get_session_messages(11, 7)
    assert [message["content"] for message in messages] == [
        "我先补充一句。", "请继续说。", "第一部分。", "还有第二部分。",
    ]
    assert messages[0] == {"message_id": None, "role": "user", "content": "我先补充一句。"}


def test_photo_only_message_keeps_empty_text_without_media_fields_or_invented_description(profile):
    service, _, interviews = profile
    context = save_context(interviews, [
        AIMessage(content="有小时候的照片吗？", id="q"),
        HumanMessage(content="", id="photo", additional_kwargs={"media_ids": [12, 13]}),
        AIMessage(content="这张照片在哪里拍的？", id="unanswered"),
    ])
    messages = service.get_session_messages(11, 7)
    assert len(messages) == 3
    assert messages[1] == {"message_id": "photo", "role": "user", "content": ""}
    assert context[1]["data"]["additional_kwargs"]["media_ids"] == [12, 13]


def test_empty_session_has_no_messages(profile):
    service, _, interviews = profile
    save_context(interviews, [])
    assert service.get_session_messages(11, 7) == []


def test_missing_or_other_users_session_uses_owner_filtered_lookup(profile):
    service, _, interviews = profile
    interviews.get.return_value = None
    assert service.get_session_messages(11, 99) == []
    interviews.get.assert_called_once_with(11, 99)


@pytest.mark.parametrize("method", ["profile", "session"])
def test_database_errors_propagate_unchanged(profile, method):
    service, repository, interviews = profile
    failure = psycopg.OperationalError("database unavailable")
    if method == "profile":
        repository.get_profile.side_effect = failure
        operation = lambda: service.get_profile(11)
    else:
        interviews.get.side_effect = failure
        operation = lambda: service.get_session_messages(11, 7)
    with pytest.raises(psycopg.OperationalError) as error:
        operation()
    assert error.value is failure


@pytest.mark.parametrize("stored", [None, {"basic_background": {"birthplace": "扬州"}}])
def test_profile_input_matches_prompt_contract_and_is_json_serializable(profile, stored):
    service, repository, interviews = profile
    repository.get_profile.return_value = stored
    save_context(interviews, [
        AIMessage(content="您小时候是在农村长大的吗？", id="msg_001"),
        HumanMessage(content="是的，我们家那时候还种地。", id="msg_002"),
    ])

    payload = service.return_profile_input(11, 7)

    assert payload == {
        "current_profile": stored if stored is not None else {},
        "session_id": "7",
        "messages": [
            {"message_id": "msg_001", "role": "assistant", "content": "您小时候是在农村长大的吗？"},
            {"message_id": "msg_002", "role": "user", "content": "是的，我们家那时候还种地。"},
        ],
    }
    assert json.loads(json.dumps(payload, ensure_ascii=False)) == payload
    repository.get_profile.assert_called_once_with(11)
    interviews.get.assert_called_once_with(11, 7)


@pytest.mark.parametrize("row", [None, {"profile_data": {}}, {"profile_data": {"name": "张三"}}])
def test_repository_filters_by_user_and_returns_only_profile_json(monkeypatch, row):
    repository = ProfileRepository("unused-database-url")
    connection = MagicMock()
    connection.__enter__.return_value = connection
    connection.execute.return_value.fetchone.return_value = row
    monkeypatch.setattr(repository, "_connect", Mock(return_value=connection))
    assert repository.get_profile(11) == (None if row is None else row["profile_data"])
    query, parameters = connection.execute.call_args.args
    assert query == "SELECT profile_data FROM user_profiles WHERE user_id = %s"
    assert parameters == (11,)
    connection.execute.assert_called_once()

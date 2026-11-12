"""整数消息编号的存储边界；不访问数据库或模型服务。"""

from copy import deepcopy

from langchain_core.messages import AIMessage, HumanMessage
import pytest

from src.common.dialogue.message_ids import (
    MAX_MESSAGE_ID, bigint_message_id, messages_from_context, messages_to_context, next_message_id,
)


def test_numeric_context_preserves_large_ids_source_references_and_other_metadata():
    messages = [
        AIMessage(content="开场", id="1"),
        HumanMessage(content="原话", id=str(MAX_MESSAGE_ID - 2), additional_kwargs={"media_ids": [12]}),
        AIMessage(content="追问", id=str(MAX_MESSAGE_ID - 1)),
        AIMessage(content="承接", id=str(MAX_MESSAGE_ID), additional_kwargs={
            "kind": "resume_opening", "resume_request_id": "return-1",
            "source_message_id": str(MAX_MESSAGE_ID - 1), "summary": "摘要",
        }),
    ]
    original = deepcopy(messages)
    context = messages_to_context(messages)
    assert [item["data"]["id"] for item in context] == [1, MAX_MESSAGE_ID - 2, MAX_MESSAGE_ID - 1, MAX_MESSAGE_ID]
    assert context[-1]["data"]["additional_kwargs"]["source_message_id"] == MAX_MESSAGE_ID - 1
    before = deepcopy(context)
    restored = messages_from_context(context)
    assert restored == messages == original
    assert context == before
    assert restored[-1].id == str(MAX_MESSAGE_ID)
    assert restored[-1].additional_kwargs["source_message_id"] == str(MAX_MESSAGE_ID - 1)


@pytest.mark.parametrize("value", [True, 0, -1, 1.5, "01", "1.0", "uuid-value", MAX_MESSAGE_ID + 1])
def test_invalid_bigint_message_ids_are_rejected(value):
    with pytest.raises(ValueError):
        bigint_message_id(value)


def test_next_message_id_uses_maximum_and_stops_at_bigint_limit():
    assert next_message_id([AIMessage(content="原话", id="8"), AIMessage(content="原话", id="3")]) == "9"
    with pytest.raises(ValueError):
        next_message_id([AIMessage(content="原话", id=str(MAX_MESSAGE_ID))])


def test_saving_context_rejects_uuid_duplicates_and_dangling_references():
    for messages in (
        [AIMessage(content="原话", id="legacy-uuid")],
        [AIMessage(content="一", id="1"), HumanMessage(content="二", id="1")],
        [AIMessage(content="承接", id="1", additional_kwargs={"source_message_id": "2"})],
    ):
        with pytest.raises(ValueError):
            messages_to_context(messages)

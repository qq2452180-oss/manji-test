"""成文问答的语境、来源边界和补充入口；不访问数据库或真实模型。"""

from copy import deepcopy
import json
from unittest.mock import Mock

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
import pytest

from src.langgraph.node import writing


def test_transcript_preserves_multi_subject_answers_and_context_as_data():
    original = "  去村里钓鱼时，我自己弄竹竿和网。其实我玩电脑更多。\n家里后来换了液晶屏。  "
    messages = [
        SystemMessage(id="hidden", content="内部提示词，不属于访谈"),
        AIMessage(id="1", content="小时候通常玩些什么？", additional_kwargs={
            "interview_context": {"user_profile": {"private": "画像内部内容"}},
        }),
        HumanMessage(id="2", content=original, additional_kwargs={"media_ids": [42]}),
        AIMessage(id="3", content="您当时应该很紧张吧？", additional_kwargs={"private": "内部信息"}),
        HumanMessage(id="4", content="不是，我没有觉得紧张。"),
    ]
    before = deepcopy(messages)

    supplied = writing.build_writing_materials({"messages": messages})

    assert len(supplied) == 1 and supplied[0][0] == "user"
    assert json.loads(supplied[0][1]) == {
        "format": "interview_transcript_v2",
        "messages": [
            {"source_turn_id": "1", "role": "assistant", "text": "小时候通常玩些什么？"},
            {"source_turn_id": "2", "role": "user", "text": original},
            {"source_turn_id": "3", "role": "assistant", "text": "您当时应该很紧张吧？"},
            {"source_turn_id": "4", "role": "user", "text": "不是，我没有觉得紧张。"},
        ],
    }
    assert messages == before


@pytest.mark.parametrize("user_text", [None, "", " \n ", "退出", " EXIT ", "Quit"])
def test_assistant_context_never_counts_as_user_material(user_text):
    messages = [AIMessage(id="1", content="请讲一段过去的经历。")]
    if user_text is not None:
        messages.extend([HumanMessage(id="2", content=user_text), AIMessage(id="3", content="好的。")])

    with pytest.raises(ValueError, match="没有可整理的用户内容"):
        writing.build_writing_materials({"messages": messages})


def test_exit_filter_does_not_remove_words_inside_a_life_experience():
    original = "后来我退出了球队，开始跟朋友学画画。"
    messages = [
        AIMessage(id="1", content="exit"),
        HumanMessage(id="2", content=" EXIT "),
        HumanMessage(id="3", content=" \n "),
        HumanMessage(id="4", content=original),
    ]

    transcript = json.loads(writing.build_writing_materials({"messages": messages})[0][1])

    assert transcript["messages"] == [
        {"source_turn_id": "1", "role": "assistant", "text": "exit"},
        {"source_turn_id": "4", "role": "user", "text": original},
    ]


@pytest.mark.parametrize("identifier", [None, "", " ", "2"])
def test_assistant_source_ids_must_be_present_and_unique_across_roles(identifier):
    messages = [
        AIMessage(id=identifier, content="您当时住在哪里？"),
        HumanMessage(id="2", content="我住在县城。"),
    ]

    with pytest.raises(ValueError, match="消息 ID"):
        writing.build_writing_materials({"messages": messages})


@pytest.mark.parametrize("message_class", [AIMessage, HumanMessage])
def test_non_text_content_is_rejected_instead_of_flattened(message_class):
    messages = [
        message_class(id="1", content=[{"type": "text", "text": "不接受隐式转换的正文"}]),
        HumanMessage(id="2", content="我小时候住在县城。"),
    ]

    with pytest.raises(ValueError):
        writing.build_writing_materials({"messages": messages})


def test_supplement_passes_existing_story_and_current_question_context(monkeypatch):
    base_story = {"title": "学徒那几年", "body": "师傅教我做木工。"}
    messages = [
        AIMessage(id="1", content="是谁教您磨刀的？"),
        HumanMessage(id="2", content="是我师傅。"),
        AIMessage(id="3", content="后来呢？"),
    ]
    model = Mock(return_value='{"title":"学徒那几年","body":"师傅教我做木工，也教我磨刀。"}')
    monkeypatch.setattr(writing, "call_qwen", model)
    repository = Mock()
    revision = {"id": 7, "attempt": 1, "status": "pending", "applied_version": None,
                "title": None, "base_story": base_story}
    repository.get_revision.return_value = revision

    writing.writing_node({
        "user_id": 1, "interview_finished": True, "revision_id": 7, "messages": messages,
    }, repository=repository)

    supplied = model.call_args.args[0]
    assert [role for role, _ in supplied] == ["system", "system", "user", "user"]
    assert json.loads(supplied[2][1].split("\n", 1)[1]) == base_story
    assert json.loads(supplied[3][1]) == {
        "format": "interview_transcript_v2",
        "messages": [
            {"source_turn_id": "1", "role": "assistant", "text": "是谁教您磨刀的？"},
            {"source_turn_id": "2", "role": "user", "text": "是我师傅。"},
            {"source_turn_id": "3", "role": "assistant", "text": "后来呢？"},
        ],
    }
    repository.apply_revision.assert_called_once_with(
        1, 7, 1, title="学徒那几年", body="师傅教我做木工，也教我磨刀。",
    )

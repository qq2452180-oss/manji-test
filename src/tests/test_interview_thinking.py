"""访谈始终关闭思考，最终正文与供应商附带的内部思考保持分离。"""

import socket
from types import SimpleNamespace
from unittest.mock import Mock

from langchain_core.messages import AIMessage, HumanMessage
import pytest

from src.langgraph.graph import build_graph
from src.langgraph.llm import qwen
from src.langgraph.node.opening_context import first_opening_context


@pytest.fixture
def model(monkeypatch):
    forbidden = Mock(side_effect=AssertionError("思考模式测试不可访问网络"))
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setenv("API_KEY", "unit-test-placeholder-key")
    monkeypatch.setenv("BASE_URL", "https://model.example.invalid/v1")
    monkeypatch.delenv("MANJI_INTERVIEW_MODE", raising=False)
    monkeypatch.delenv("MANJI_TEXT_TIMEOUT_SECONDS", raising=False)
    instance = Mock()
    instance.invoke.return_value = AIMessage(
        content="您那时通常先忙些什么？",
        additional_kwargs={"reasoning_content": "内部思考不能播报或进入访谈记录。"},
    )
    constructor = Mock(return_value=instance)
    monkeypatch.setattr(qwen, "ChatOpenAI", constructor)
    return SimpleNamespace(instance=instance, constructor=constructor)


@pytest.mark.parametrize("options,expected", [({}, False), ({"enable_thinking": True}, True)])
def test_thinking_is_opt_in_and_only_final_text_is_returned(model, options, expected):
    result = qwen.call_qwen([("user", "我想讲讲以前开店的事。")], **options)

    assert result == "您那时通常先忙些什么？"
    assert model.constructor.call_args.kwargs["extra_body"] == {"enable_thinking": expected}
    assert model.constructor.call_args.kwargs["model_kwargs"] == {}


def test_thinking_without_final_text_is_not_used_as_a_reply(model):
    model.instance.invoke.return_value = AIMessage(
        content="",
        additional_kwargs={"reasoning_content": "仅有思考内容，还没有面向用户的回复。"},
    )

    with pytest.raises(ValueError, match="内容为空"):
        qwen.call_qwen([("user", "我以前开过店。")], enable_thinking=True)


@pytest.mark.parametrize("old_mode", [None, "agent", "legacy"])
def test_interview_disables_thinking_for_opening_and_followup(model, monkeypatch, old_mode):
    if old_mode is not None:
        monkeypatch.setenv("MANJI_INTERVIEW_MODE", old_mode)
    graph = build_graph()
    config = {"configurable": {"thread_id": "thinking-interview"}}
    opening = graph.invoke({
        "opening_context": first_opening_context(),
        "interview_context": {"interview_scope": "global", "selected_topic": None},
    }, config)

    continued = graph.invoke({
        "messages": [HumanMessage(id="2", content="以前每天开店先扫地，再摆货。")],
    }, config)

    assert opening["opening_text"] == continued["assistant_text"] == "您那时通常先忙些什么？"
    assert model.constructor.call_count == 2
    assert all(
        call.kwargs["extra_body"] == {"enable_thinking": False}
        for call in model.constructor.call_args_list
    )
    model.instance.bind_tools.assert_not_called()
    assert len(continued["messages"]) == 3
    assert all("reasoning_content" not in message.additional_kwargs for message in continued["messages"])

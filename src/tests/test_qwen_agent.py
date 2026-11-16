"""工具调用入口的离线契约测试；不读取真实凭据、不访问外部模型。"""

import socket
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from openai import APITimeoutError, BadRequestError
import pytest

from src.langgraph.llm import agent, qwen


MESSAGES = [("user", "我想讲讲以前修收音机的事。")]
TOOLS = [{
    "type": "function",
    "function": {
        "name": "load_skill",
        "description": "读取一项访谈技能。",
        "parameters": {
            "type": "object", "properties": {"name": {"type": "string"}},
            "required": ["name"], "additionalProperties": False,
        },
    },
}]
CALL = {"name": "load_skill", "args": {"name": "active-listening"}, "id": "call_1"}


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    forbidden = Mock(side_effect=AssertionError("工具调用测试不可访问网络"))
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setenv("API_KEY", "unit-test-placeholder-key")
    monkeypatch.setenv("BASE_URL", "https://model.example.invalid/v1")
    monkeypatch.delenv("MANJI_TEXT_TIMEOUT_SECONDS", raising=False)


@pytest.fixture
def model(monkeypatch):
    bound = Mock()
    bound.invoke.return_value = AIMessage(content="那时您是怎么开始修理的？")
    instance = Mock()
    instance.bind_tools.return_value = bound
    constructor = Mock(return_value=instance)
    monkeypatch.setattr(agent, "ChatOpenAI", constructor)
    return SimpleNamespace(constructor=constructor, instance=instance, bound=bound)


def test_native_tool_call_keeps_empty_content_ids_and_metadata(model):
    response = AIMessage(
        content="", tool_calls=[CALL], id="model-message-1",
        response_metadata={"finish_reason": "tool_calls"},
    )
    model.bound.invoke.return_value = response

    result = agent.call_qwen_with_tools(MESSAGES, tools=TOOLS)

    assert result is response
    assert result.tool_calls[0]["id"] == "call_1"
    assert result.tool_calls[0]["args"] == {"name": "active-listening"}
    assert result.content == ""
    model.instance.bind_tools.assert_called_once_with(TOOLS, tool_choice="auto")
    model.bound.invoke.assert_called_once_with(MESSAGES)
    model.instance.invoke.assert_not_called()


def test_final_none_call_preserves_native_tool_history_and_text(model):
    messages = [
        HumanMessage(content=MESSAGES[0][1]),
        AIMessage(content="", tool_calls=[CALL]),
        ToolMessage(content="先理解用户当前重点。", tool_call_id="call_1"),
    ]
    response = model.bound.invoke.return_value

    assert agent.call_qwen_with_tools(messages, tools=TOOLS, tool_choice="none") is response

    model.instance.bind_tools.assert_called_once_with(TOOLS, tool_choice="none")
    model.bound.invoke.assert_called_once_with(messages)
    assert response.content == "那时您是怎么开始修理的？"


def test_model_configuration_keeps_existing_credentials_thinking_and_retry_rules(model):
    agent.call_qwen_with_tools(MESSAGES, tools=TOOLS)

    model.constructor.assert_called_once_with(
        model=qwen.QWEN_MODEL, api_key="unit-test-placeholder-key",
        base_url="https://model.example.invalid/v1", timeout=60.0,
        max_retries=0, extra_body={"enable_thinking": False},
    )


@pytest.mark.parametrize("content,expected", [
    ("", ValueError), (" \n ", ValueError),
    ([{"type": "text", "text": "不可作为纯文本播报"}], TypeError),
])
def test_final_response_requires_nonempty_plain_text(model, content, expected):
    model.bound.invoke.return_value = AIMessage(content=content)

    with pytest.raises(expected):
        agent.call_qwen_with_tools(MESSAGES, tools=TOOLS)


def test_invalid_tool_calls_are_rejected_even_with_valid_text_and_another_call(model):
    model.bound.invoke.return_value = AIMessage(
        content="普通文字不能掩盖损坏的工具调用。", tool_calls=[CALL],
        invalid_tool_calls=[{
            "name": "load_skill", "args": "{bad json", "id": "call_2", "error": "invalid JSON",
        }],
    )

    with pytest.raises(ValueError, match="工具调用无效"):
        agent.call_qwen_with_tools(MESSAGES, tools=TOOLS)


def test_final_none_call_rejects_provider_ignoring_tool_choice(model):
    model.bound.invoke.return_value = AIMessage(content="", tool_calls=[CALL])

    with pytest.raises(ValueError, match="最终回复中仍请求调用工具"):
        agent.call_qwen_with_tools(MESSAGES, tools=TOOLS, tool_choice="none")


def test_empty_messages_fail_before_constructing_a_model(model):
    with pytest.raises(ValueError, match="messages cannot be empty"):
        agent.call_qwen_with_tools([], tools=TOOLS)

    model.constructor.assert_not_called()


def bad_request(body):
    request = httpx.Request("POST", "https://model.example.invalid/v1/chat/completions")
    return BadRequestError("private-provider-detail", response=httpx.Response(400, request=request), body=body)


@pytest.mark.parametrize("body", [
    {"code": "Arrearage"}, {"error": {"type": "Arrearage"}},
])
def test_provider_account_errors_keep_safe_business_classification(model, body):
    model.bound.invoke.side_effect = bad_request(body)

    with pytest.raises(qwen.ModelAccountUnavailableError) as caught:
        agent.call_qwen_with_tools(MESSAGES, tools=TOOLS)

    assert caught.value.code == "MODEL_ACCOUNT_UNAVAILABLE"
    assert "private-provider-detail" not in str(caught.value)


def test_other_provider_errors_are_not_misclassified(model):
    error = bad_request({"code": "InvalidParameter", "message": "Arrearage"})
    model.bound.invoke.side_effect = error

    with pytest.raises(BadRequestError) as caught:
        agent.call_qwen_with_tools(MESSAGES, tools=TOOLS)

    assert caught.value is error


def test_provider_timeout_keeps_existing_translation(model):
    error = APITimeoutError(httpx.Request("POST", "https://model.example.invalid/v1/chat/completions"))
    model.bound.invoke.side_effect = error

    with pytest.raises(TimeoutError, match="Qwen 模型请求超时") as caught:
        agent.call_qwen_with_tools(MESSAGES, tools=TOOLS)

    assert caught.value.__cause__ is error


@pytest.mark.parametrize("remaining,expected", [(None, 12), (5, 5), (30, 12)])
def test_remaining_timeout_never_extends_voice_budget(model, monkeypatch, remaining, expected):
    monkeypatch.setenv("MANJI_TEXT_TIMEOUT_SECONDS", "45")
    with qwen.qwen_timeout_limit(12):
        assert agent.agent_timeout_seconds() == 12
        agent.call_qwen_with_tools(MESSAGES, tools=TOOLS, timeout_seconds=remaining)
        assert agent.agent_timeout_seconds() == 12

    assert model.constructor.call_args.kwargs["timeout"] == expected
    assert agent.agent_timeout_seconds() == 45


@pytest.mark.parametrize("remaining", [0, -1, float("inf"), True])
def test_invalid_remaining_timeout_fails_before_request(model, remaining):
    with pytest.raises(ValueError, match="正有限秒数"):
        agent.call_qwen_with_tools(MESSAGES, tools=TOOLS, timeout_seconds=remaining)

    model.constructor.assert_not_called()


def test_whole_turn_budget_obeys_text_limit_and_nested_voice_limits(monkeypatch):
    monkeypatch.setenv("MANJI_TEXT_TIMEOUT_SECONDS", "9.5")
    assert agent.agent_timeout_seconds() == 9.5
    with qwen.qwen_timeout_limit(20):
        assert agent.agent_timeout_seconds() == 9.5
        with qwen.qwen_timeout_limit(3):
            assert agent.agent_timeout_seconds() == 3
        assert agent.agent_timeout_seconds() == 9.5

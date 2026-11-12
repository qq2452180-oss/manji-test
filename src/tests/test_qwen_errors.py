"""模型账户异常分类；所有请求使用替身，不访问外部模型或读取真实密钥。"""

import socket
from unittest.mock import Mock

import httpx
from langchain_openai.chat_models.base import OpenAIInvalidRequestError
from openai import APITimeoutError, BadRequestError
import pytest

from src.langgraph.llm import qwen


SAFE_MESSAGE = "AI 访谈服务暂不可用，请联系管理员检查模型服务账户状态"
PRIVATE_DETAIL = "private-provider-response-and-key"
MESSAGES = [("user", "合成测试问题")]


@pytest.fixture
def model(monkeypatch):
    forbidden = Mock(side_effect=AssertionError("模型异常测试不可访问网络"))
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setenv("API_KEY", "unit-test-placeholder-key")
    monkeypatch.setenv("BASE_URL", "https://model.example.invalid/v1")
    monkeypatch.delenv("MANJI_TEXT_TIMEOUT_SECONDS", raising=False)
    instance = Mock()
    monkeypatch.setattr(qwen, "ChatOpenAI", Mock(return_value=instance))
    return instance


def bad_request(body):
    request = httpx.Request("POST", "https://model.example.invalid/v1/chat/completions")
    response = httpx.Response(400, request=request)
    return BadRequestError(PRIVATE_DETAIL, response=response, body=body)


@pytest.mark.parametrize("body", [
    {"code": "Arrearage", "message": PRIVATE_DETAIL},
    {"type": "Arrearage", "message": PRIVATE_DETAIL},
    {"error": {"code": "Arrearage", "message": PRIVATE_DETAIL}},
    {"error": {"type": "Arrearage", "message": PRIVATE_DETAIL}},
])
def test_structured_arrearage_returns_safe_account_error(model, body):
    model.invoke.side_effect = bad_request(body)

    with pytest.raises(qwen.ModelAccountUnavailableError) as caught:
        qwen.call_qwen(MESSAGES)

    assert caught.value.code == "MODEL_ACCOUNT_UNAVAILABLE"
    assert str(caught.value) == SAFE_MESSAGE
    assert PRIVATE_DETAIL not in str(caught.value)
    model.invoke.assert_called_once_with(MESSAGES)


@pytest.mark.parametrize("attribute", ["code", "type"])
def test_structured_exception_attributes_are_supported(model, attribute):
    error = bad_request(None)
    setattr(error, attribute, "Arrearage")
    model.invoke.side_effect = error

    with pytest.raises(qwen.ModelAccountUnavailableError) as caught:
        qwen.call_qwen(MESSAGES)

    assert caught.value.code == "MODEL_ACCOUNT_UNAVAILABLE"
    assert str(caught.value) == SAFE_MESSAGE


def test_real_langchain_bad_request_wrapper_is_classified(model):
    original = bad_request({
        "error": {"code": "Arrearage", "type": "Arrearage", "message": PRIVATE_DETAIL},
    })

    def fail(_messages):
        try:
            raise original
        except BadRequestError as exc:
            raise OpenAIInvalidRequestError(
                message=exc.message, response=exc.response, body=exc.body,
            ) from exc

    model.invoke.side_effect = fail

    with pytest.raises(qwen.ModelAccountUnavailableError) as caught:
        qwen.call_qwen(MESSAGES)

    assert caught.value.code == "MODEL_ACCOUNT_UNAVAILABLE"
    assert str(caught.value) == SAFE_MESSAGE
    assert PRIVATE_DETAIL not in str(caught.value)


@pytest.mark.parametrize("body", [
    {"code": "InvalidParameter", "message": "Arrearage"},
    {"error": {"code": "InvalidParameter", "message": "Arrearage"}},
    {"code": "arrearage"},
    {"code": "Arrearage.Other"},
    {"message": "Arrearage"},
    {"error": "Arrearage"},
    "Arrearage",
    None,
])
def test_other_400_errors_and_free_text_are_not_reclassified(model, body):
    error = bad_request(body)
    model.invoke.side_effect = error

    with pytest.raises(BadRequestError) as caught:
        qwen.call_qwen(MESSAGES)

    assert caught.value is error


def test_non_provider_error_with_arrearage_text_is_unchanged(model):
    error = ValueError("Arrearage")
    model.invoke.side_effect = error

    with pytest.raises(ValueError) as caught:
        qwen.call_qwen(MESSAGES)

    assert caught.value is error


def test_existing_timeout_translation_is_preserved(model):
    error = APITimeoutError(httpx.Request("POST", "https://model.example.invalid/v1/chat/completions"))
    model.invoke.side_effect = error

    with pytest.raises(TimeoutError, match="Qwen 模型请求超时") as caught:
        qwen.call_qwen(MESSAGES)

    assert caught.value.__cause__ is error

"""画像提取请求与返回值；模型和数据库均不做真实调用。"""

from copy import deepcopy
import json
from pathlib import Path
from unittest.mock import Mock

import psycopg
import pytest

from src.service.profile import ProfileService, extractor


@pytest.fixture(autouse=True)
def no_live_calls(monkeypatch):
    monkeypatch.setattr(psycopg, "connect", Mock(side_effect=AssertionError("不可连接真实数据库")))
    monkeypatch.setattr(extractor, "call_qwen", Mock(side_effect=AssertionError("不可调用真实模型")))


@pytest.fixture
def profile_input():
    return {
        "current_profile": {"basic_background": {"current_location": "合肥"}},
        "session_id": "7",
        "messages": [
            {"message_id": "q1", "role": "assistant", "content": "您现在住在哪里？"},
            {"message_id": "a1", "role": "user", "content": "现在住杭州。\n保留我的原话。"},
        ],
    }


def test_request_keeps_prompt_separate_from_structured_interview_data(monkeypatch, profile_input):
    result = {"updates": [], "reviews": []}
    model = Mock(return_value=json.dumps(result, ensure_ascii=False))
    monkeypatch.setattr(extractor, "call_qwen", model)
    original = deepcopy(profile_input)

    assert extractor.extract_profile_updates(profile_input) == result

    model.assert_called_once()
    request = model.call_args.args[0]
    prompt_path = Path(__file__).resolve().parents[1] / "langgraph/prompt/profile/user_profile.md"
    assert len(request) == 2
    assert request[0] == ("system", prompt_path.read_text(encoding="utf-8").strip())
    assert request[1][0] == "user"
    assert json.loads(request[1][1]) == original
    assert "杭州" in request[1][1]
    assert model.call_args.kwargs == {"json_output": True}
    assert profile_input == original


def test_service_uses_existing_input_builder_then_extractor(monkeypatch, profile_input):
    service = ProfileService(Mock(), Mock())
    build_input = Mock(return_value=profile_input)
    extract = Mock(return_value={"updates": [], "reviews": []})
    monkeypatch.setattr(service, "return_profile_input", build_input)
    monkeypatch.setattr(extractor, "extract_profile_updates", extract)

    assert service.extract_profile_updates(11, "7") == extract.return_value

    build_input.assert_called_once_with(11, "7")
    extract.assert_called_once_with(profile_input)


def test_model_error_propagates_unchanged(monkeypatch, profile_input):
    failure = RuntimeError("model unavailable")
    monkeypatch.setattr(extractor, "call_qwen", Mock(side_effect=failure))
    with pytest.raises(RuntimeError) as error:
        extractor.extract_profile_updates(profile_input)
    assert error.value is failure


def test_invalid_json_preserves_the_parser_error(monkeypatch, profile_input):
    response = "not valid JSON"
    monkeypatch.setattr(extractor, "call_qwen", Mock(return_value=response))
    with pytest.raises(json.JSONDecodeError) as error:
        extractor.extract_profile_updates(profile_input)
    assert error.value.doc == response

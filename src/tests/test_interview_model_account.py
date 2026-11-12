"""模型账户不可用时返回安全分类，并保留原有访谈和成文重试流程。"""

from copy import deepcopy
from io import BytesIO

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from src.api.auth.dependencies import get_current_user_id
from src.api.interview.router import interview_error, router
from src.langgraph.llm.qwen import ModelAccountUnavailableError
from src.service.interview import InterviewError
from src.tests.workflow_support import make_interview_flow


DETAIL = "AI 访谈服务暂不可用，请联系管理员检查模型服务账户状态"
CODE = "MODEL_ACCOUNT_UNAVAILABLE"
USER_TEXT = "我小时候住在乡下。"


@pytest.fixture
def flow(monkeypatch):
    return make_interview_flow(monkeypatch, with_biography=True)


@pytest.fixture
def client(flow):
    app = FastAPI()
    app.state.interview = flow.service
    app.include_router(router)
    app.add_exception_handler(InterviewError, interview_error)
    app.dependency_overrides[get_current_user_id] = lambda: 1
    with TestClient(app) as value:
        yield value


def failure():
    error = ModelAccountUnavailableError()
    error.__cause__ = RuntimeError("private-provider-key and full provider response")
    return error


def assert_response(response, session_id):
    assert response.status_code == 503
    assert response.json() == {"detail": DETAIL, "code": CODE, "session_id": session_id}
    assert "private-provider" not in response.text
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("topic", [False, True], ids=["global", "chapter"])
def test_failed_opening_and_retry_return_account_code_without_creating_another_session(flow, client, topic):
    flow.model.side_effect = failure()
    body = {"resume_mode": "text", **({"topic_id": flow.topic["id"]} if topic else {})}
    first = client.post("/api/interviews", json=body)
    session_id = first.json()["session_id"]
    assert_response(first, session_id)
    assert_response(client.post(f"/api/interviews/{session_id}/retry"), session_id)
    assert len(flow.repository.rows) == 1
    assert flow.repository.rows[int(session_id)]["context"] == []

    flow.model.side_effect = None
    flow.model.return_value = "想聊哪段往事？"
    recovered = client.post(f"/api/interviews/{session_id}/retry")
    assert recovered.status_code == 200
    assert recovered.json()["session_id"] == session_id
    assert len(flow.repository.rows[int(session_id)]["context"]) == 1


def test_text_input_http_error_preserves_the_submitted_message_and_same_retry(flow, client):
    session_id = client.post("/api/interviews", json={"resume_mode": "text"}).json()["session_id"]
    flow.model.side_effect = failure()
    path = f"/api/interviews/{session_id}"
    assert_response(client.post(path + "/input", json={"text": USER_TEXT}), session_id)
    saved = deepcopy(flow.repository.rows[int(session_id)]["context"])
    assert [message["type"] for message in saved] == ["ai", "human"]
    assert saved[-1]["data"]["content"] == USER_TEXT
    assert_response(client.post(path + "/retry"), session_id)
    assert flow.repository.rows[int(session_id)]["context"] == saved

    flow.model.side_effect = None
    flow.model.return_value = "后来呢？"
    assert client.post(path + "/retry").status_code == 200
    assert [message["type"] for message in flow.repository.rows[int(session_id)]["context"]] == ["ai", "human", "ai"]


@pytest.mark.parametrize("mode", ["voice", "photo"])
def test_other_input_modes_share_the_same_safe_service_error(flow, mode):
    session_id = flow.service.start(1, resume_mode=mode)["session_id"]
    flow.model.side_effect = failure()
    with pytest.raises(InterviewError) as caught:
        if mode == "voice":
            flow.service.submit_voice(1, session_id, USER_TEXT)
        else:
            flow.service.upload_photo(1, session_id, BytesIO(b"photo"), USER_TEXT)
    assert (str(caught.value), caught.value.code, caught.value.status_code, caught.value.session_id) == (
        DETAIL, CODE, 503, session_id,
    )
    assert flow.repository.rows[int(session_id)]["context"][-1]["data"]["content"] == USER_TEXT


@pytest.mark.parametrize("stage", ["writer", "summarizer", "merger"])
def test_finish_reports_account_failure_and_resumes_without_losing_saved_work(flow, client, stage):
    session_id = flow.service.start(1, resume_mode="text")["session_id"]
    flow.service.submit_text(1, session_id, USER_TEXT)
    # Ensure the biography stage needs its model instead of the first-story shortcut.
    flow.biography_repository.rows[1] = {"body": "已有传记。"}
    model = getattr(flow, stage)
    previous_effect = model.side_effect
    model.side_effect = failure()
    path = f"/api/interviews/{session_id}/finish"
    assert_response(client.post(path), session_id)
    saved_context = deepcopy(flow.repository.rows[int(session_id)]["context"])
    saved_stories = deepcopy(flow.stories)
    if stage != "writer":
        assert len(saved_stories) == 1
        assert next(iter(saved_stories.values()))["body"] == USER_TEXT
    assert flow.biography_repository.rows[1]["body"] == "已有传记。"

    model.side_effect = previous_effect
    recovered = client.post(path)
    assert recovered.status_code == 200
    assert recovered.json()["status"] == "completed"
    assert len(flow.stories) == 1
    assert flow.repository.rows[int(session_id)]["context"] == saved_context
    if stage != "writer":
        assert flow.writer.call_count == 1


def test_unrelated_model_failure_keeps_existing_http_error_behavior(flow, client):
    flow.model.side_effect = ValueError("private-provider-invalid-request")
    response = client.post("/api/interviews", json={"resume_mode": "text"})
    assert response.status_code == 502
    assert response.json()["detail"] == "首问生成失败，请重试"
    assert "code" not in response.json()
    assert "private-provider" not in response.text

"""普通 RTC 的离线契约：接通、回答、挂断；不访问网络或数据库。"""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import socket
from threading import Event, Lock
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from src.api.auth.dependencies import get_current_user, get_current_user_id
from src.api.rtc.router import router
from src.common.tencent_rtc import TencentRtcError
from src.service.interview import InterviewError
from src.service.rtc import RtcError
from src.service.rtc.direct import DirectRtcService


OWNER = 11
SESSION = "7"
TEXT = "小时候我住在河边。"
ANSWER = "那条河边有什么让您记得很清楚的事？"


@pytest.fixture
def rtc(monkeypatch):
    forbidden = Mock(side_effect=AssertionError("普通 RTC 测试不可连接网络或数据库"))
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr("psycopg.connect", forbidden)
    history = [{"id": "1", "role": "assistant", "content": "我们聊聊您的故事。"}]
    session_lock, tasks = Lock(), {}

    def require_ready(owner, session_id):
        if (owner, session_id) != (OWNER, SESSION):
            raise InterviewError("会话不存在", 404)
        if history[-1]["role"] == "user":
            raise InterviewError("上一轮回复尚未完成", 409)

    def submit_voice(owner, session_id, text, *, timeout_seconds=None):
        with session_lock:
            require_ready(owner, session_id)
            message_id = int(history[-1]["id"]) + 1
            history.extend([
                {"id": str(message_id), "role": "user", "content": text},
                {"id": str(message_id + 1), "role": "assistant", "content": ANSWER},
            ])
            return {"assistant_text": ANSWER, "assistant_message_id": str(message_id + 1)}

    interview = SimpleNamespace(
        require_voice_ready=Mock(side_effect=require_ready),
        submit_voice=Mock(side_effect=submit_voice),
        get_session=Mock(side_effect=lambda owner, session_id: {"messages": deepcopy(history)}),
    )

    def create_join_params(user_id, room_id, *, call_id):
        return {"sdk_app_id": 1400000001, "room_id": room_id, "user_id": user_id,
                "user_sig": "test-signature", "bot_user_id": "test-bot",
                "private_map_key": "test-map-key", "expires_at": 9999999999}

    def start_conversation(**options):
        task_id = f"task-{len(tasks) + 1}"
        tasks[options["call_id"]] = {"TaskId": task_id, "Status": "InProgress"}
        return task_id

    def describe_conversation(*, task_id=None, call_id=None):
        if call_id is not None:
            return deepcopy(tasks.get(call_id))
        return deepcopy(next((task for task in tasks.values() if task["TaskId"] == task_id), None))

    def stop_conversation(task_id):
        for task in tasks.values():
            if task["TaskId"] == task_id:
                task["Status"] = "Stopped"

    provider = SimpleNamespace(
        config=SimpleNamespace(sdk_app_id=1400000001, llm_timeout_seconds=5,
                               request_timeout_seconds=0.01, llm_model="test-interview"),
        create_join_params=Mock(side_effect=create_join_params),
        start_conversation=Mock(side_effect=start_conversation),
        describe_conversation=Mock(side_effect=describe_conversation),
        stop_conversation=Mock(side_effect=stop_conversation),
        verify_llm_request=Mock(), verify_callback=Mock(),
    )
    return SimpleNamespace(service=DirectRtcService(provider, interview), provider=provider,
                           interview=interview, history=history,
                           submit_voice=submit_voice, start_cloud=start_conversation)


def prepare(rtc, request_id="call-request"):
    return rtc.service.prepare(OWNER, SESSION, request_id)


def active_call(rtc):
    call = prepare(rtc)
    return rtc.service.start(OWNER, call["call_id"])


def bridge_context(call, request_id="voice-request"):
    return {"sdk_app_id": str(call["sdk_app_id"]), "room_id": str(call["room_id"]),
            "room_id_type": "0", "user_id": call["rtc_user_id"],
            "task_id": call["task_id"], "request_id": request_id}


def utterance(text=TEXT):
    return {"stream": False, "messages": [{"role": "user", "content": text}]}


def test_prepare_does_not_start_cloud_and_start_plays_existing_question(rtc):
    before = deepcopy(rtc.history)
    call = prepare(rtc)
    assert call["status"] == "PREPARED"
    assert call["credentials"]["bot_user_id"] == "test-bot"
    assert call["credentials"]["private_map_key"] == "test-map-key"
    rtc.provider.start_conversation.assert_not_called()
    rtc.interview.get_session.assert_not_called()
    assert rtc.service.start(OWNER, call["call_id"])["status"] == "ACTIVE"
    assert rtc.provider.start_conversation.call_args.kwargs["welcome_message"] == before[-1]["content"]
    rtc.interview.get_session.assert_called_once_with(OWNER, SESSION)
    rtc.interview.submit_voice.assert_not_called()
    assert rtc.history == before


def test_reply_writes_once_and_redial_plays_latest_saved_reply(rtc):
    call = active_call(rtc)
    context = bridge_context(call)
    first = rtc.service.reply(context, TEXT)
    assert rtc.service.reply(context, TEXT) == first
    assert first == {"call_id": call["call_id"], "assistant_text": ANSWER, "assistant_message_id": "3"}
    rtc.interview.submit_voice.assert_called_once()
    assert rtc.interview.submit_voice.call_args.args == (OWNER, SESSION, TEXT)
    assert rtc.interview.submit_voice.call_args.kwargs["timeout_seconds"] > 0
    assert len(rtc.history) == 3
    assert rtc.history[-2]["content"] == TEXT
    assert rtc.history[-1]["content"] == ANSWER
    assert rtc.service.get(OWNER, call["call_id"])["turn_pending"] is False
    before_redial = deepcopy(rtc.history)
    rtc.service.stop(OWNER, call["call_id"])
    redial = prepare(rtc, request_id="redial-latest-reply")
    assert rtc.service.start(OWNER, redial["call_id"])["status"] == "ACTIVE"
    assert rtc.provider.start_conversation.call_args.kwargs["welcome_message"] == ANSWER
    rtc.interview.submit_voice.assert_called_once()
    assert rtc.history == before_redial


def test_failed_history_read_does_not_start_cloud_and_can_retry(rtc):
    call = prepare(rtc)
    read_session = rtc.interview.get_session.side_effect
    rtc.interview.get_session.side_effect = InterviewError("访谈历史读取失败，请重试", 503)
    with pytest.raises(InterviewError):
        rtc.service.start(OWNER, call["call_id"])
    rtc.provider.start_conversation.assert_not_called()
    assert rtc.service.get(OWNER, call["call_id"])["status"] == "PREPARED"
    rtc.interview.get_session.side_effect = read_session
    assert rtc.service.start(OWNER, call["call_id"])["status"] == "ACTIVE"
    rtc.provider.start_conversation.assert_called_once()
    assert rtc.provider.start_conversation.call_args.kwargs["welcome_message"] == rtc.history[-1]["content"]


def test_start_does_not_replay_an_older_question_when_latest_message_is_user(rtc):
    call = prepare(rtc)
    # 模拟就绪检查后历史发生变化，不能向前翻找上一条问题播报。
    rtc.interview.require_voice_ready.side_effect = None
    rtc.history.append({"id": "2", "role": "user", "content": TEXT})
    before = deepcopy(rtc.history)
    with pytest.raises(RtcError) as not_ready:
        rtc.service.start(OWNER, call["call_id"])
    assert not_ready.value.code == "RTC_NOT_READY"
    assert not_ready.value.status_code == 409
    rtc.provider.start_conversation.assert_not_called()
    rtc.interview.submit_voice.assert_not_called()
    assert rtc.service.get(OWNER, call["call_id"])["status"] == "PREPARED"
    assert rtc.history == before


def test_concurrent_duplicate_shares_result_and_conflicting_input_never_submits(rtc):
    call = active_call(rtc)
    entered, release, duplicate_started = Event(), Event(), Event()
    context = bridge_context(call)

    def delayed_reply(*args, **kwargs):
        entered.set()
        assert release.wait(timeout=5)
        return rtc.submit_voice(*args, **kwargs)

    def duplicate():
        duplicate_started.set()
        return rtc.service.reply(context, TEXT)

    rtc.interview.submit_voice.side_effect = delayed_reply
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(rtc.service.reply, context, TEXT)
        try:
            assert entered.wait(timeout=5)
            second = pool.submit(duplicate)
            assert duplicate_started.wait(timeout=5)
            with pytest.raises(RtcError) as conflict:
                rtc.service.reply(context, "相同请求编号却是另一段话。")
            assert conflict.value.code == "RTC_REQUEST_CONFLICT"
            with pytest.raises(RtcError) as overlapping:
                rtc.service.reply(bridge_context(call, "another-request"), "下一轮讲述。")
            assert overlapping.value.code == "RTC_TURN_PENDING"
        finally:
            release.set()
        assert first.result(timeout=5) == second.result(timeout=5)
    rtc.interview.submit_voice.assert_called_once()


def test_stop_during_generation_keeps_history_but_does_not_return_playable_reply(rtc):
    call = active_call(rtc)
    entered, release = Event(), Event()

    def delayed_reply(*args, **kwargs):
        entered.set()
        assert release.wait(timeout=5)
        return rtc.submit_voice(*args, **kwargs)

    rtc.interview.submit_voice.side_effect = delayed_reply
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(rtc.service.reply, bridge_context(call), TEXT)
        try:
            assert entered.wait(timeout=5)
            assert rtc.service.stop(OWNER, call["call_id"])["status"] in {"STOPPING", "STOPPED"}
            rtc.provider.stop_conversation.assert_called_once_with(call["task_id"])
        finally:
            release.set()
        with pytest.raises(RtcError) as closed:
            pending.result(timeout=5)
        assert closed.value.code == "RTC_CALL_CLOSED"
    assert rtc.history[-1]["content"] == ANSWER
    assert rtc.service.get(OWNER, call["call_id"])["turn_pending"] is False
    with pytest.raises(RtcError):
        rtc.service.reply(bridge_context(call), TEXT)
    rtc.interview.submit_voice.assert_called_once()
    assert prepare(rtc, request_id="redial")["call_id"] != call["call_id"]


def test_stop_during_cloud_start_stops_the_late_task(rtc):
    entered, release, stop_requested = Event(), Event(), Event()
    call = prepare(rtc)

    def delayed_start(**options):
        entered.set()
        assert release.wait(timeout=5)
        return rtc.start_cloud(**options)

    def stop():
        stop_requested.set()
        return rtc.service.stop(OWNER, call["call_id"])

    rtc.provider.start_conversation.side_effect = delayed_start
    with ThreadPoolExecutor(max_workers=2) as pool:
        starting = pool.submit(rtc.service.start, OWNER, call["call_id"])
        try:
            assert entered.wait(timeout=5)
            stopping = pool.submit(stop)
            assert stop_requested.wait(timeout=5)
        finally:
            release.set()
        starting.result(timeout=5)
        assert stopping.result(timeout=5)["status"] == "STOPPED"
    rtc.provider.start_conversation.assert_called_once()
    rtc.provider.stop_conversation.assert_called_once_with("task-1")
    assert rtc.service.get(OWNER, call["call_id"])["status"] == "STOPPED"


def test_prepare_and_start_retries_reuse_one_call_even_when_interview_is_now_busy(rtc):
    first = prepare(rtc)
    started = rtc.service.start(OWNER, first["call_id"])
    rtc.interview.require_voice_ready.side_effect = InterviewError("上一轮正在生成", 409)
    assert prepare(rtc)["call_id"] == first["call_id"]
    assert rtc.service.start(OWNER, first["call_id"])["task_id"] == started["task_id"]
    rtc.provider.start_conversation.assert_called_once()
    rtc.interview.get_session.assert_called_once_with(OWNER, SESSION)


def test_concurrent_starts_create_only_one_cloud_task(rtc):
    call = prepare(rtc)
    entered, release, second_started = Event(), Event(), Event()

    def delayed_start(**options):
        entered.set()
        assert release.wait(timeout=5)
        return rtc.start_cloud(**options)

    def second_start():
        second_started.set()
        return rtc.service.start(OWNER, call["call_id"])

    rtc.provider.start_conversation.side_effect = delayed_start
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(rtc.service.start, OWNER, call["call_id"])
        try:
            assert entered.wait(timeout=5)
            second = pool.submit(second_start)
            assert second_started.wait(timeout=5)
        finally:
            release.set()
        assert first.result(timeout=5)["task_id"] == second.result(timeout=5)["task_id"] == "task-1"
    rtc.provider.start_conversation.assert_called_once()


def test_restart_rejects_old_call_and_old_task(rtc):
    call = active_call(rtc)
    restarted = DirectRtcService(rtc.provider, rtc.interview)
    with pytest.raises(RtcError) as missing:
        restarted.get(OWNER, call["call_id"])
    assert missing.value.status_code == 404
    with pytest.raises(RtcError):
        restarted.reply(bridge_context(call), TEXT)
    rtc.interview.submit_voice.assert_not_called()
    fresh = restarted.prepare(OWNER, SESSION, "new-process-call")
    assert fresh["call_id"] != call["call_id"]
    assert fresh["rtc_user_id"] != call["rtc_user_id"]


@pytest.mark.parametrize("method", ["get", "start", "stop"])
def test_other_owner_cannot_manage_call(rtc, method):
    call = prepare(rtc)
    with pytest.raises(RtcError) as forbidden:
        getattr(rtc.service, method)(OWNER + 1, call["call_id"])
    assert forbidden.value.status_code == 404
    rtc.provider.start_conversation.assert_not_called()
    rtc.provider.stop_conversation.assert_not_called()


def test_other_owner_cannot_prepare_another_users_interview(rtc):
    with pytest.raises((RtcError, InterviewError)) as forbidden:
        rtc.service.prepare(OWNER + 1, SESSION, "wrong-owner")
    assert forbidden.value.status_code == 404
    rtc.provider.create_join_params.assert_not_called()


@pytest.mark.parametrize("field,value", [
    ("sdk_app_id", "1400000002"), ("room_id", "999"), ("room_id_type", "1"),
    ("user_id", "another-rtc-user"), ("task_id", "unknown-task"),
])
def test_verified_context_must_still_match_call_binding(rtc, field, value):
    call = active_call(rtc)
    if field == "room_id":
        value = str(call["room_id"] + 1)
    with pytest.raises(RtcError) as forbidden:
        rtc.service.reply({**bridge_context(call), field: value}, TEXT)
    assert forbidden.value.status_code in {403, 404}
    rtc.interview.submit_voice.assert_not_called()


@pytest.mark.parametrize("failure", [InterviewError("访谈保存失败", 503), RuntimeError("unexpected-test-error")],
                         ids=["interview-error", "unexpected-error"])
def test_reply_failure_clears_pending_and_duplicate_does_not_submit_again(rtc, failure):
    call = active_call(rtc)
    context = bridge_context(call)
    rtc.interview.submit_voice.side_effect = failure
    with pytest.raises((type(failure), RtcError)):
        rtc.service.reply(context, TEXT)
    assert rtc.service.get(OWNER, call["call_id"])["turn_pending"] is False
    with pytest.raises((type(failure), RtcError)):
        rtc.service.reply(context, TEXT)
    rtc.interview.submit_voice.assert_called_once()
    assert rtc.service.stop(OWNER, call["call_id"])["status"] == "STOPPED"
    assert prepare(rtc, request_id="after-failed-call")["call_id"] != call["call_id"]


def test_duplicate_timeout_keeps_original_execution_and_result(rtc):
    call = active_call(rtc)
    rtc.provider.config.llm_timeout_seconds = 0.01
    entered, release = Event(), Event()
    context = bridge_context(call)

    def delayed_reply(*args, **kwargs):
        entered.set()
        assert release.wait(timeout=5)
        return rtc.submit_voice(*args, **kwargs)

    rtc.interview.submit_voice.side_effect = delayed_reply
    with ThreadPoolExecutor(max_workers=1) as pool:
        original = pool.submit(rtc.service.reply, context, TEXT)
        try:
            assert entered.wait(timeout=5)
            with pytest.raises(RtcError) as pending:
                rtc.service.reply(context, TEXT)
            assert pending.value.code == "RTC_TURN_PENDING"
            assert pending.value.status_code == 503
            assert rtc.service.get(OWNER, call["call_id"])["turn_pending"] is True
        finally:
            release.set()
        result = original.result(timeout=5)
    assert rtc.service.reply(context, TEXT) == result
    rtc.interview.submit_voice.assert_called_once()


def test_uncertain_start_retry_queries_original_call_without_starting_again(rtc):
    call = prepare(rtc)

    def started_but_response_lost(**options):
        rtc.start_cloud(**options)
        raise TencentRtcError("RTC_PROVIDER_UNCERTAIN", "启动回包超时")

    rtc.provider.start_conversation.side_effect = started_but_response_lost
    with pytest.raises(TencentRtcError):
        rtc.service.start(OWNER, call["call_id"])
    recovered = rtc.service.start(OWNER, call["call_id"])
    assert recovered["status"] == "ACTIVE"
    assert recovered["task_id"] == "task-1"
    rtc.provider.describe_conversation.assert_called_once_with(call_id=call["call_id"])
    rtc.provider.start_conversation.assert_called_once()


def test_stop_after_uncertain_start_closes_local_call_even_if_task_is_not_found(rtc):
    call = prepare(rtc)
    rtc.provider.start_conversation.side_effect = TencentRtcError("RTC_PROVIDER_UNCERTAIN", "启动回包超时")
    with pytest.raises(TencentRtcError):
        rtc.service.start(OWNER, call["call_id"])
    assert rtc.service.stop(OWNER, call["call_id"])["status"] == "STOPPED"
    rtc.provider.describe_conversation.assert_called_once_with(call_id=call["call_id"])
    rtc.provider.stop_conversation.assert_not_called()
    assert prepare(rtc, request_id="after-uncertain-call")["call_id"] != call["call_id"]


def test_redial_retries_failed_stop_before_replacing_closed_call(rtc):
    call = active_call(rtc)
    stop_cloud = rtc.provider.stop_conversation.side_effect
    rtc.provider.stop_conversation.side_effect = TencentRtcError(
        "RTC_PROVIDER_UNCERTAIN", "停止回包超时",
    )
    with pytest.raises(TencentRtcError):
        rtc.service.stop(OWNER, call["call_id"])
    rtc.provider.stop_conversation.side_effect = stop_cloud
    replacement = prepare(rtc, request_id="after-stop-timeout")
    assert replacement["call_id"] != call["call_id"]
    assert replacement["status"] == "PREPARED"
    assert rtc.provider.stop_conversation.call_count == 2
    assert all(args.args == (call["task_id"],) for args in rtc.provider.stop_conversation.call_args_list)
    rtc.interview.submit_voice.assert_not_called()


def test_early_callback_waits_for_start_and_does_not_submit_after_stop(rtc):
    call = prepare(rtc)
    started, release, callback_entered = Event(), Event(), Event()

    def delayed_start(**options):
        task_id = rtc.start_cloud(**options)
        started.set()
        assert release.wait(timeout=5)
        return task_id

    def callback():
        callback_entered.set()
        return rtc.service.reply(bridge_context({**call, "task_id": "task-1"}), TEXT)

    rtc.provider.start_conversation.side_effect = delayed_start
    with ThreadPoolExecutor(max_workers=2) as pool:
        starting = pool.submit(rtc.service.start, OWNER, call["call_id"])
        try:
            assert started.wait(timeout=5)
            replying = pool.submit(callback)
            assert callback_entered.wait(timeout=5)
            rtc.interview.submit_voice.assert_not_called()
        finally:
            release.set()
        assert starting.result(timeout=5)["status"] == "ACTIVE"
        assert replying.result(timeout=5)["assistant_text"] == ANSWER
    rtc.service.stop(OWNER, call["call_id"])
    with pytest.raises(RtcError):
        callback()
    rtc.interview.submit_voice.assert_called_once()


@pytest.fixture
def http_client(rtc):
    app = FastAPI()
    app.state.rtc = rtc.service
    app.include_router(router)
    app.dependency_overrides[get_current_user_id] = lambda: OWNER
    app.dependency_overrides[get_current_user] = lambda: {"id": OWNER}
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def test_http_credentials_answer_and_private_cache_contract(rtc, http_client):
    prepared = http_client.post(f"/api/interviews/{SESSION}/calls", json={"client_request_id": "http-call"})
    assert prepared.status_code == 201
    call = prepared.json()
    assert call["credentials"]["user_sig"] == "test-signature"
    started = http_client.post(f"/api/rtc/calls/{call['call_id']}/start")
    assert started.status_code == 200
    rtc.provider.verify_llm_request.return_value = bridge_context(started.json())
    reply = http_client.post("/api/rtc/llm/chat/completions", json=utterance())
    assert reply.status_code == 200
    message = reply.json()["choices"][0]["message"]
    assert message["content"] == ANSWER
    assert message["metainfo"]["assistant_message_id"] == "3"
    stopped = http_client.post(f"/api/rtc/calls/{call['call_id']}/stop")
    assert stopped.status_code == 200
    assert stopped.json()["status"] == "STOPPED"
    for response in (prepared, started, reply, stopped):
        assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("payload", [
    {**utterance(), "stream": True},
    {"messages": []},
    {"messages": [{"role": "assistant", "content": TEXT}]},
    {"messages": [{"role": "user", "content": [{"type": "text", "text": TEXT}]}]},
])
def test_http_rejects_invalid_llm_payload_before_submitting(rtc, http_client, payload):
    call = active_call(rtc)
    rtc.provider.verify_llm_request.return_value = bridge_context(call)
    response = http_client.post("/api/rtc/llm/chat/completions", json=payload)
    assert response.status_code == 422
    assert response.json()["code"] == "RTC_INVALID_REQUEST"
    assert response.headers["cache-control"] == "private, no-store"
    rtc.interview.submit_voice.assert_not_called()


@pytest.mark.parametrize("legacy_fields", [
    {"resume_kind": "home_return", "resume_request_id": "old-request"},
    {"resume_kind": "pause_replay", "resume_message_id": "3"},
    {"resume_message_id": "3"},
    {"resume_kind": "home_return", "resume_request_id": "old-request", "resume_message_id": "3"},
    {"resume_kind": "pause_continue"},
])
def test_http_ignores_old_options_and_plays_existing_question(rtc, http_client, legacy_fields):
    before = deepcopy(rtc.history)
    prepared = http_client.post(f"/api/interviews/{SESSION}/calls", json={
        "client_request_id": "old-client", **legacy_fields,
    })
    assert prepared.status_code == 201
    started = http_client.post(f"/api/rtc/calls/{prepared.json()['call_id']}/start")
    assert started.status_code == 200
    assert rtc.provider.start_conversation.call_args.kwargs["welcome_message"] == before[-1]["content"]
    rtc.interview.get_session.assert_called_once_with(OWNER, SESSION)
    rtc.interview.submit_voice.assert_not_called()
    assert rtc.history == before


@pytest.mark.parametrize("failure_at,status,code", [
    ("bridge-auth", 401, "RTC_BRIDGE_UNAUTHORIZED"),
    ("event-auth", 401, "RTC_EVENT_UNAUTHORIZED"),
    ("provider", 502, "RTC_PROVIDER_FAILED"),
    ("prepare-interview", 409, "RTC_SESSION_NOT_READY"),
    ("reply-interview", 503, "RTC_TURN_FAILED"),
])
def test_http_known_errors_keep_status_and_cache_control(rtc, http_client, failure_at, status, code):
    path, payload = f"/api/interviews/{SESSION}/calls", {"client_request_id": "http-error"}
    if failure_at in {"bridge-auth", "event-auth"}:
        method = rtc.provider.verify_llm_request if failure_at == "bridge-auth" else rtc.provider.verify_callback
        method.side_effect = TencentRtcError("RTC_UNAUTHORIZED", "请求身份无效")
        path = "/api/rtc/llm/chat/completions" if failure_at == "bridge-auth" else "/api/rtc/events"
        payload = utterance() if failure_at == "bridge-auth" else {}
    elif failure_at == "provider":
        rtc.provider.create_join_params.side_effect = TencentRtcError("RTC_PROVIDER_FAILED", "腾讯请求失败")
    elif failure_at == "prepare-interview":
        rtc.interview.require_voice_ready.side_effect = InterviewError("上一轮尚未完成", 409)
    else:
        call = active_call(rtc)
        rtc.provider.verify_llm_request.return_value = bridge_context(call)
        rtc.interview.submit_voice.side_effect = InterviewError("访谈保存失败", 503)
        path, payload = "/api/rtc/llm/chat/completions", utterance()
    response = http_client.post(path, json=payload)
    assert response.status_code == status
    assert response.json()["code"] == code
    assert response.headers["cache-control"] == "private, no-store"


def test_close_stops_active_task_and_can_be_repeated(rtc):
    call = active_call(rtc)
    rtc.service.close()
    assert rtc.service.get(OWNER, call["call_id"])["status"] == "STOPPED"
    rtc.service.close()
    rtc.provider.stop_conversation.assert_called_once_with(call["task_id"])


def test_application_uses_direct_service_without_rtc_repository_and_closes_on_exit(rtc, monkeypatch, tmp_path):
    from src.api import app as application

    monkeypatch.setattr(application, "load_dotenv", Mock())
    monkeypatch.setattr(application, "build_graph", Mock(return_value=object()))
    monkeypatch.setattr(application, "InterviewService", Mock(return_value=rtc.interview))
    app = application.create_app(database_url="", media_directory=tmp_path, rtc_provider=rtc.provider)
    app.dependency_overrides[get_current_user_id] = lambda: OWNER
    with TestClient(app) as client:
        assert isinstance(app.state.rtc, DirectRtcService)
        prepared = client.post(f"/api/interviews/{SESSION}/calls", json={"client_request_id": "assembled"})
        assert prepared.status_code == 201
        started = client.post(f"/api/rtc/calls/{prepared.json()['call_id']}/start")
        assert started.status_code == 200
        task_id = started.json()["task_id"]
    rtc.provider.stop_conversation.assert_called_once_with(task_id)

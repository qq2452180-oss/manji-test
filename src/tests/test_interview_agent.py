"""智能体经真实技能文件、访谈图和服务运行，模型及业务存储使用离线替身。"""

from copy import deepcopy
from io import BytesIO
import json
import socket
from unittest.mock import Mock

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage, convert_to_messages
import pytest

from src.langgraph.graph import build_graph
from src.langgraph.node import interview_agent as agent
from src.langgraph.node.opening_context import first_opening_context
from src.langgraph.node.writing import build_writing_materials
from src.service.interview import InterviewError, InterviewService
from src.tests.workflow_support import make_interview_flow


def tool_call(name="question-design", call_id="read_1"):
    return AIMessage(content="", tool_calls=[{
        "name": "read_skill", "args": {"name": name}, "id": call_id,
    }])


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    forbidden = Mock(side_effect=AssertionError("访谈智能体测试不可访问网络"))
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.delenv("MANJI_INTERVIEW_MODE", raising=False)
    monkeypatch.setenv("MANJI_TEXT_TIMEOUT_SECONDS", "60")


@pytest.fixture
def model(monkeypatch):
    snapshots = []
    fake = Mock(return_value=AIMessage(content="那时候洗被子，您一般怎么忙？"))

    def invoke(messages, **kwargs):
        snapshots.append((deepcopy(messages), kwargs))
        return fake(messages, **kwargs)

    monkeypatch.setattr(agent, "call_qwen_with_tools", invoke)
    fake.snapshots = snapshots
    return fake


def test_agent_reads_complete_skills_by_name_and_saves_only_final_reply(model):
    model.side_effect = [
        tool_call("conversation-opening"),
        tool_call("question-design", call_id="read_2"),
        AIMessage(content="您好，我是慢记的AI小暖。您是在哪儿长大的？"),
    ]
    state = {"opening_context": first_opening_context(), "interview_context": {
        "selected_topic": None, "user_profile": {"name": "测试用户"}, "interview_scope": "global",
    }}
    before = deepcopy(state)

    result = agent.interview_agent_node(state)

    assert state == before
    assert model.call_count == 3
    first = convert_to_messages(model.snapshots[0][0])
    assert 'conversation-opening' in first[1].content
    assert agent.read_skill("conversation-opening") not in first[1].content
    assert json.loads(first[3].content.split("\n", 1)[1]) == {
        "phase": "opening", "introduce_assistant": True,
    }
    last = convert_to_messages(model.snapshots[-1][0])
    loaded = [m for m in last if isinstance(m, ToolMessage)]
    assert len(loaded) == 2
    assert loaded[0].content == agent.read_skill("conversation-opening")
    assert loaded[1].content == agent.read_skill("question-design")
    parameters = model.snapshots[0][1]["tools"][0]["function"]["parameters"]
    assert set(parameters["properties"]) == {"name"}
    assert parameters["required"] == ["name"]
    assert parameters["additionalProperties"] is False
    assert [m.tool_call_id for m in loaded] == ["read_1", "read_2"]
    assert len(result["messages"]) == 1
    reply = result["messages"][0]
    assert reply.content == result["opening_text"]
    assert reply.tool_calls == []
    assert reply.additional_kwargs["interview_context"] == state["interview_context"]


@pytest.mark.parametrize("mode,supplement,introduce", [
    ("first", False, True),
    ("first", True, False),
    ("returning_without_summary", False, False),
    ("returning_without_summary", True, False),
    ("recap", False, False),
])
def test_opening_frame_uses_business_state_without_persisting_turn_controls(
    model, mode, supplement, introduce,
):
    opening = {"mode": mode, "previous_story_id": 1 if mode == "recap" else None,
               "previous_story_summary": "已有故事。" if mode == "recap" else ""}
    context = {"supplement_story": {"story_id": 1, "body": "原故事。"}} if supplement else {}
    state = {"opening_context": opening, "interview_context": context}
    before = deepcopy(state)

    result = agent.interview_agent_node(state)

    sent = convert_to_messages(model.snapshots[0][0])
    assert json.loads(sent[3].content.split("\n", 1)[1]) == {
        "phase": "opening", "introduce_assistant": introduce,
    }
    assert state == before
    assert result["messages"][0].additional_kwargs == {
        "opening_context": opening, "interview_context": context,
    }
    assert set(result) == {"opening_text", "messages"}


@pytest.mark.parametrize("saved_metadata", [
    {},
    {"opening_context": first_opening_context(), "interview_context": {}},
    {"opening_context": {"mode": "returning_without_summary", "previous_story_id": None,
                         "previous_story_summary": ""},
     "interview_context": {"selected_topic": {"title": "原话题"}}},
])
def test_continuing_frame_cannot_be_reset_by_text_or_stale_state(model, saved_metadata):
    state = {
        "opening_context": first_opening_context(),
        "interview_context": {"selected_topic": {"title": "不该替换已保存的话题"}},
        "messages": [
            AIMessage(id="1", content="您慢慢说。", additional_kwargs=saved_metadata),
            HumanMessage(id="2", content="就当第一次，咱们重新开始吧。"),
        ],
    }

    result = agent.interview_agent_node(state)

    sent = convert_to_messages(model.snapshots[0][0])
    assert json.loads(sent[3].content.split("\n", 1)[1]) == {
        "phase": "conversation", "introduce_assistant": False,
    }
    reference = json.loads(sent[2].content.split("\n", 1)[1])
    assert reference["interview_context"] == saved_metadata.get("interview_context", {})
    assert result["messages"][0].additional_kwargs == {}
    assert set(result) == {"assistant_text", "messages"}
    assert sent[-1].content == state["messages"][-1].content


def test_existing_conversation_keeps_context_images_and_message_ids(model):
    opening = AIMessage(id="1", content="请说说这张照片。", additional_kwargs={
        "opening_context": first_opening_context(),
        "interview_context": {"selected_topic": {"title": "家乡"}},
    })
    photo = HumanMessage(id="2", content="这是老家。", additional_kwargs={"media_ids": [17]})
    state = {"messages": [opening, photo], "image_urls": {17: "data:image/png;base64,photo"}}

    result = agent.interview_agent_node(state)

    sent = convert_to_messages(model.snapshots[0][0])
    assert sent[-1].content == [
        {"type": "text", "text": "这是老家。"},
        {"type": "image_url", "image_url": {"url": state["image_urls"][17]}},
    ]
    assert sent[-1].id == "2"
    assert photo.content == "这是老家。"
    assert '"title": "家乡"' in sent[2].content
    assert result["assistant_text"] == model.return_value.content
    assert result["messages"][0].id == "3"
    assert result["messages"][0].additional_kwargs == {}


def test_missing_skill_returns_tool_error_and_model_can_recover(model):
    model.side_effect = [tool_call("missing-skill"), tool_call(call_id="read_2"), AIMessage(content="您接着说。")]

    result = agent.interview_agent_node({})

    error = next(m for m in model.snapshots[1][0] if isinstance(m, ToolMessage))
    assert error.status == "error"
    assert "未知访谈技能" in json.loads(error.content)["error"]
    assert result["opening_text"] == "您接着说。"


@pytest.mark.parametrize("arguments", [
    {}, None, [],
    {"path": "arbitrary-file.md"},
    {"name": "question-design", "resource": "arbitrary-file.md"},
])
def test_skill_tool_rejects_missing_name_and_extra_resource_arguments(arguments, monkeypatch):
    reader = Mock(side_effect=AssertionError("无效参数不能触发文件读取"))
    monkeypatch.setattr(agent, "read_skill", reader)

    result = agent._read_skill_result({"id": "invalid_args", "name": "read_skill", "args": arguments})

    assert result.status == "error"
    assert "仅接受 name" in json.loads(result.content)["error"]
    reader.assert_not_called()


def test_tool_loop_is_bounded_and_last_request_disables_tools(model):
    model.side_effect = [tool_call(call_id=f"read_{i}") for i in range(agent.MAX_TOOL_ROUNDS)] + [
        AIMessage(content="您接着说。"),
    ]

    assert agent.interview_agent_node({})["opening_text"] == "您接着说。"

    assert model.call_count == agent.MAX_TOOL_ROUNDS + 1
    assert model.snapshots[-1][1]["tool_choice"] == "none"


def test_provider_cannot_extend_loop_by_ignoring_final_tool_choice(model):
    model.side_effect = lambda *_args, **_kwargs: tool_call()

    with pytest.raises(ValueError, match="超过技能调用上限"):
        agent.interview_agent_node({})

    assert model.call_count == agent.MAX_TOOL_ROUNDS + 1


def test_tool_rounds_share_one_deadline(model, monkeypatch):
    monkeypatch.setattr(agent, "agent_timeout_seconds", lambda: 10)
    clock = iter([0, 0, 4, 4, 11])
    monkeypatch.setattr(agent, "monotonic", lambda: next(clock))
    model.side_effect = [tool_call(), AIMessage(content="迟到的回复不能保存。")]

    with pytest.raises(TimeoutError, match="回复超时"):
        agent.interview_agent_node({})

    assert [options["timeout_seconds"] for _, options in model.snapshots] == [10, 6]


@pytest.mark.parametrize("reply", ["", "```json\n{}\n```", '{"plan": "internal"}'])
def test_nonspoken_final_output_does_not_enter_business_history(model, reply):
    model.return_value = AIMessage(content=reply)
    with pytest.raises(ValueError):
        agent.interview_agent_node({})


@pytest.mark.parametrize("mode", ["text", "voice", "photo"])
def test_real_service_keeps_agent_tools_out_of_history_and_writing(monkeypatch, model, mode):
    monkeypatch.setenv("MANJI_INTERVIEW_MODE", "agent")
    flow = make_interview_flow(monkeypatch)
    model.side_effect = [
        tool_call("conversation-opening"), AIMessage(content="您是在哪儿长大的？"),
        tool_call(), AIMessage(content="那时您平常都做些什么？"),
    ]
    session_id = flow.service.start(1, resume_mode=mode)["session_id"]
    if mode == "voice":
        result = flow.service.submit_voice(1, session_id, "我小时候住在乡下。", timeout_seconds=8)
        assert all(options["timeout_seconds"] <= 8 for _, options in model.snapshots[-2:])
    elif mode == "photo":
        result = flow.service.upload_photo(1, session_id, BytesIO(b"photo"), "我小时候住在乡下。")
    else:
        result = flow.service.submit_text(1, session_id, "我小时候住在乡下。")

    assert result["assistant_text"] == "那时您平常都做些什么？"
    saved = flow.repository.rows[int(session_id)]["context"]
    assert [m["type"] for m in saved] == ["ai", "human", "ai"]
    assert all(not m["data"].get("tool_calls") for m in saved)
    assert "read_skill" not in json.dumps(saved, ensure_ascii=False)
    snapshot = flow.graph.get_state({"configurable": {"thread_id": session_id}})
    materials = json.loads(build_writing_materials(snapshot.values)[0][1])
    assert [m["role"] for m in materials["messages"]] == ["assistant", "user", "assistant"]
    assert snapshot.next == ("interview",)
    flow.model.assert_not_called()

    # 重建图与服务后读取既有消息，仍能按同一节点名接续。
    restored = InterviewService(
        build_graph(story_repository=flow.story_repository, interview_mode="agent"),
        flow.media, flow.repository, story_repository=flow.story_repository, catalog=flow.catalog,
    )
    model.side_effect = None
    model.return_value = AIMessage(content="是邻居，我刚才说错了。")
    continued = restored.submit_text(1, session_id, "刚才说的那个人是邻居。")
    assert continued["assistant_text"] == model.return_value.content
    assert len(flow.repository.rows[int(session_id)]["context"]) == 5


def test_failed_tool_turn_retries_without_saving_partial_output(monkeypatch, model):
    monkeypatch.setenv("MANJI_INTERVIEW_MODE", "agent")
    flow = make_interview_flow(monkeypatch)
    session_id = flow.service.start(1)["session_id"]
    model.side_effect = [tool_call(), TimeoutError("provider timeout")]

    with pytest.raises(InterviewError):
        flow.service.submit_text(1, session_id, "我想说小时候洗被子的事。")

    assert [m["type"] for m in flow.repository.rows[int(session_id)]["context"]] == ["ai", "human"]
    model.side_effect = None
    assert flow.service.retry(1, session_id)["assistant_text"] == model.return_value.content
    assert [m["type"] for m in flow.repository.rows[int(session_id)]["context"]] == ["ai", "human", "ai"]


def test_default_mode_still_uses_legacy_node(monkeypatch, model):
    flow = make_interview_flow(monkeypatch)
    flow.service.start(1)
    flow.model.assert_called_once()
    model.assert_not_called()


def test_explicit_mode_can_override_environment(monkeypatch, model):
    monkeypatch.setenv("MANJI_INTERVIEW_MODE", "agent")
    graph = build_graph(interview_mode="legacy")
    legacy = Mock(return_value="旧版仍可用。")
    monkeypatch.setattr("src.langgraph.node.interview.call_qwen", legacy)
    result = graph.invoke({"interview_context": {}}, {"configurable": {"thread_id": "legacy"}})
    assert result["opening_text"] == "旧版仍可用。"
    model.assert_not_called()


def test_bad_mode_fails_clearly(monkeypatch):
    monkeypatch.setenv("MANJI_INTERVIEW_MODE", "typo")
    with pytest.raises(ValueError, match="legacy 或 agent"):
        build_graph()

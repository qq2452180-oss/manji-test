"""访谈、成文、记忆更新与摘要组成四节点流程。"""

from functools import partial
from typing import Literal

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from ...service.story import StoryRepository
from ...service.profile import ProfileService
from ...service.life_event import LifeEventService
from ..node.interview import interview_node
from ..node.memory_update import memory_update_node
from ..node.summary import summary_node
from ..node.writing import writing_node
from ..state import WorkflowState


def route_interview(
    state: WorkflowState,
) -> Literal["interview", "writing"]:
    """只有用户确认成稿才进入 writing，其余情况继续访谈。"""
    return "writing" if state.get("interview_finished") else "interview"


def build_graph(
    checkpointer: BaseCheckpointSaver | None = None,
    *, story_repository: StoryRepository | None = None,
    profile_service: ProfileService | None = None,
    life_event_service: LifeEventService | None = None,
) -> CompiledStateGraph:
    """访谈节点生成首问及逐轮回复，每轮后暂停等待新输入。

    默认 checkpoint 只存内存，进程重启后丢失；可传入持久化 checkpointer。
    章节故事继承原章节，全局故事不归章；传记更新由服务层在成文完成后调用。
    """
    if checkpointer is None:
        checkpointer = InMemorySaver()
    builder = StateGraph(WorkflowState)

    builder.add_node("interview", interview_node)
    builder.add_node("writing", partial(writing_node, repository=story_repository))
    builder.add_node("memory_update", partial(
        memory_update_node, profile_service=profile_service,
        life_event_service=life_event_service, repository=story_repository,
    ))
    builder.add_node("summary", partial(summary_node, repository=story_repository))

    builder.add_edge(START, "interview")
    builder.add_conditional_edges("interview", route_interview, {
        "interview": "interview",
        "writing": "writing",
    })
    builder.add_edge("writing", "memory_update")
    builder.add_edge("memory_update", "summary")
    builder.add_edge("summary", END)

    return builder.compile(checkpointer=checkpointer, interrupt_after=["interview"])

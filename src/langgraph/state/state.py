"""开场内容、会话历史、图片材料和成稿数据。"""

from typing import Annotated, Literal, TypedDict

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages


class OpeningContext(TypedDict):
    """新访谈的开场背景；不属于本场用户素材或成稿结果。"""

    mode: Literal["first", "recap", "returning_without_summary"]
    previous_story_id: int | None
    previous_story_summary: str


class WorkflowState(TypedDict, total=False):
    # 服务端从登录身份或已保存会话中取得的用户编号。
    user_id: int
    # 仅兼容旧会话保存的规划，新访谈直接使用所选话题与记忆。
    interview_plan: dict
    # 所选话题、画像、经历索引与故事摘要，首问及后续回复共用。
    interview_context: dict
    opening_text: str
    opening_context: OpeningContext
    # 使用 reducer 合并各节点新增的消息，避免覆盖既有会话历史。
    messages: Annotated[list[AnyMessage], add_messages]
    # 按媒体 ID 保存已读取的图片 data URL；每条消息通过自己的 media_ids 取图。
    image_urls: dict[int, str]
    assistant_text: str
    interview_finished: bool
    ##write节点
    title: str
    body: str
    story_id: int
    target_story_id: int
    revision_id: int
    revision_status: str
    source_session_id: str
    photo_layout: list[dict]
    # 章节成文继承话题章节；全局故事为空，不由模型归章。
    chapter_id: int | None
    # 已处理也包括本场没有新增画像信息，或经历归纳决定跳过。
    profile_processed: bool
    life_event_processed: bool
    # 成稿后生成并保存的访谈摘要，不属于用户原始讲述。
    summary: str

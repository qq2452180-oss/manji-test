"""管理访谈会话的保存、恢复、用户归属和进程内锁。"""

import base64
from threading import Lock
from typing import Callable, Literal, get_args

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph.state import CompiledStateGraph
import psycopg

from ...langgraph.state import WorkflowState
from ...langgraph.node.interview_context import saved_interview_context, saved_interview_plan, is_global_interview
from ...common.dialogue.message_ids import messages_from_context, messages_to_context
from ..media import MediaService
from ..story import StoryRepository
from .repository import InterviewSessionRepository

ResumeMode = Literal["text", "photo", "voice"]

MAX_SESSION_ID = 2**63 - 1  # PostgreSQL BIGINT 上限。


class InterviewError(ValueError):
    def __init__(self, message: str, status_code: int, session_id: str | None = None, *, code: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.session_id = session_id
        self.code = code


def validate_resume_mode(resume_mode: ResumeMode | None, *, allow_none: bool = False) -> None:
    if resume_mode not in get_args(ResumeMode) and not (allow_none and resume_mode is None):
        raise InterviewError("请选择文字、图片或语音聊天", 422)


class InterviewSessionManager:
    def __init__(
        self, graph: CompiledStateGraph, media: MediaService,
        repository: InterviewSessionRepository,
        *, story_repository: StoryRepository | None = None,
        load_start_context: Callable[[int], WorkflowState] | None = None,
    ) -> None:
        self.graph = graph
        self._media = media
        self._repository = repository
        self._stories = story_repository
        self._load_start_context = load_start_context
        # 问答内容在图中；这里只缓存归属、恢复模式、会话锁和保存标记。
        self.sessions = {}
        self._restore_lock = Lock()

    def register(
        self, session_id: str, user_id: int, *, save_pending: bool = False,
        resume_mode: ResumeMode | None = None,
    ):
        """新建或恢复会话后登记运行信息，返回该会话的锁。"""
        session = {
            "user_id": user_id,
            "resume_mode": resume_mode,
            "lock": Lock(),
            "save_pending": save_pending,
        }
        self.sessions[session_id] = session
        return session["lock"]

    def require_saved(self, session_id: str) -> None:
        if self.sessions[session_id]["save_pending"]:
            raise InterviewError("会话尚未保存，请先重试", 409, session_id)

    def save(self, session_id: str) -> None:
        """保存访谈暂停点；末条用户消息也落库，供模型失败后恢复并重试。"""
        snapshot = self.graph.get_state(graph_config(session_id))
        if snapshot.next not in ((), ("interview",), ("writing",), ("memory_update",), ("summary",)):
            raise InterviewError("本轮尚未完成，不能保存暂停快照", 409)

        session = self.sessions[session_id]
        session["save_pending"] = True
        try:
            saved_record = self._repository.save(
                user_id=session["user_id"],
                session_id=int(session_id),
                context=messages_to_context(snapshot.values["messages"]),
                finished=bool(snapshot.values.get("interview_finished")),
            )
        except psycopg.Error as exc:
            raise InterviewError("会话保存失败，请重试", 503, session_id) from exc
        except ValueError as exc:
            raise InterviewError("会话消息编号无效，请重新载入访谈", 409, session_id) from exc
        if saved_record is None:
            raise InterviewError("会话不存在", 404)
        session["save_pending"] = False

    # 恢复与归属：已有会话使用内存，缺失时才读取数据库。

    def _restore_session(self, record: dict) -> None:
        """从原始消息上下文重建图状态，不重放开场或历史模型调用。"""
        session_id = str(record['id'])
        if not record['context']:
            initial = {}
            revision = None
            if self._stories is not None and hasattr(self._stories, 'get_revision_by_session'):
                candidate = self._stories.get_revision_by_session(record['user_id'], session_id)
                revision = candidate if isinstance(candidate, dict) else None
            if revision is not None:
                base = revision['base_story']
                original = self._repository.get(record['user_id'], int(base['source_session_id']))
                source_messages = messages_from_context(original['context']) if original else []
                source_context = saved_interview_context(source_messages) or {}
                topic = source_context.get('selected_topic')
                if isinstance(topic, dict):
                    # 尚无首问快照时按新会话加载记忆；已有快照的恢复不重新读取。
                    initial = self._load_start_context(record['user_id']) if self._load_start_context else {
                        'opening_context': {'mode': 'returning_without_summary', 'previous_story_id': None,
                                            'previous_story_summary': ''},
                        'interview_context': {},
                    }
                    if not topic.get('chapter_title'):
                        stories = initial['interview_context'].get('life_event_context', {}).get('stories', [])
                        title = next((story.get('chapter_title') for story in stories
                                      if story['story_id'] == revision['story_id']
                                      and story.get('chapter_id') == topic.get('chapter_id')), None)
                        if title:
                            topic = {**topic, 'chapter_title': title}
                    initial['interview_context'].update(selected_topic=topic, supplement_story={
                        'story_id': revision['story_id'], 'title': base['title'], 'body': base['body'],
                    })
            if not initial.get('interview_context', {}).get('selected_topic'):
                raise InterviewError('会话尚无可恢复的暂停记录，请重新开始访谈', 409)
            state = {'user_id': record['user_id'], 'source_session_id': session_id,
                     'messages': [], 'interview_finished': False, **initial}
            if revision is not None:
                state.update(revision_id=revision['id'], target_story_id=revision['story_id'],
                             revision_status=revision['status'])
            self.graph.update_state(graph_config(session_id), state, as_node='interview')
            return

        # 1. 恢复消息，保留消息 ID 和每轮的图片引用。
        messages = messages_from_context(record["context"])
        user_messages = [message for message in messages if isinstance(message, HumanMessage)]

        # 2. 恢复最近回复及历史图片；已结束会话成稿只需要原始文字。
        state: WorkflowState = {
            "user_id": record["user_id"],
            "source_session_id": session_id,
            "messages": messages,
            "opening_text": messages[0].content,
            "interview_finished": record["finish_time"] is not None,
        }
        plan = saved_interview_plan(messages)
        if plan is not None:
            state["interview_plan"] = plan
        interview_context = saved_interview_context(messages)
        if interview_context is not None:
            state["interview_context"] = interview_context
        if user_messages:
            latest_assistant = next((message for message in reversed(messages) if isinstance(message, AIMessage)), None)
            if latest_assistant is not None:
                state["assistant_text"] = latest_assistant.content
            if not state["interview_finished"]:
                image_urls = {}
                for message in user_messages:
                    for media_id in message.additional_kwargs.get("media_ids", []):
                        if media_id not in image_urls:
                            image_urls[media_id] = self.load_photo_data_url(
                                record["user_id"], session_id, media_id,
                            )
                state["image_urls"] = image_urls

        if self._stories is not None and hasattr(self._stories, 'get_revision_by_session'):
            revision = self._stories.get_revision_by_session(record['user_id'], session_id)
            if isinstance(revision, dict):
                state.update(revision_id=revision['id'], target_story_id=revision['story_id'],
                             revision_status=revision['status'])

        # 3. 已结束会话从持久化结果定位下一步；完成的会话直接恢复到终点。
        last_node = "interview"
        if state["interview_finished"] and self._stories is not None:
            try:
                story = self._stories.get_by_session(record["user_id"], session_id)
            except psycopg.Error as exc:
                raise InterviewError("故事进度读取失败，请重试", 503) from exc
            if story is not None:
                state.update(story)
                if story.get("chapter_id") is None and not is_global_interview(state):
                    # 旧流程可能已存正文但缺章；重新进入成文节点，只补章节。
                    last_node = "interview"
                elif not story.get("profile_processed", True) or not story.get("life_event_processed", True):
                    last_node = "writing"
                elif not (story.get("summary") or "").strip():
                    last_node = "memory_update"
                else:
                    last_node = "summary"
        config = graph_config(session_id)
        self.graph.update_state(config, state, as_node=last_node)

    def get_or_restore_lock(self, session_id: str, user_id: int):
        """检查归属，必要时先恢复会话，再返回该会话共用的锁。"""
        is_numeric_id = session_id.isascii() and session_id.isdecimal()
        if not is_numeric_id or len(session_id) > 19:
            raise InterviewError("会话不存在，请先开始访谈", 404)

        database_id = int(session_id)
        if not 0 < database_id <= MAX_SESSION_ID or str(database_id) != session_id:
            raise InterviewError("会话不存在，请先开始访谈", 404)

        # 防止并发请求为同一会话重复恢复图、创建不同的锁。
        with self._restore_lock:
            session = self.sessions.get(session_id)
            if session is None:
                try:
                    record = self._repository.get(user_id, database_id)
                except psycopg.Error as exc:
                    raise InterviewError("会话读取失败，请重试", 503) from exc
                if record is None:
                    raise InterviewError("会话不存在，请先开始访谈", 404)
                self._restore_session(record)
                self.register(session_id, user_id, resume_mode=record.get("resume_mode"))
                session = self.sessions[session_id]
            if session["user_id"] != user_id:
                raise InterviewError("会话不存在，请先开始访谈", 404)
            return session["lock"]

    def load_photo_data_url(self, user_id: int, session_id: str, media_id: int) -> str:
        """通过媒体服务读取原图，转换为模型使用的图片 URL。"""
        data, mime_type = self._media.read(user_id, session_id, media_id)
        encoded_image = base64.b64encode(data).decode("ascii")
        return f"data:{mime_type};base64,{encoded_image}"


def has_pending_input(state: WorkflowState) -> bool:
    """末条用户消息尚未获得 AI 回复时，只能重试，不能接收下一条输入。"""
    messages = state.get("messages", [])
    return bool(messages and isinstance(messages[-1], HumanMessage))


def graph_config(session_id: str) -> dict:
    return {"configurable": {"thread_id": session_id}}


def serialize_messages(state: WorkflowState) -> list[dict]:
    """仅用于接口展示：图中的消息转成四字段格式，图片只保留 ID。"""
    return [
        {
            "id": message.id,
            "role": "user" if isinstance(message, HumanMessage) else "assistant",
            "content": message.content,
            "image_ids": message.additional_kwargs.get("media_ids", []),
        }
        for message in state["messages"]
    ]

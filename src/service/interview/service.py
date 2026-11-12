"""接收访谈请求并调用图；会话保存与恢复交给 InterviewSessionManager。"""

from copy import deepcopy
from typing import BinaryIO

from langgraph.graph.state import CompiledStateGraph
from langchain_core.messages import AIMessage, HumanMessage
import psycopg

from ...langgraph.state import OpeningContext, WorkflowState
from ...common.dialogue.message_ids import next_message_id
from ...langgraph.llm.qwen import ModelAccountUnavailableError, qwen_timeout_limit
from ...langgraph.node.interview_context import interview_chapter_id, saved_interview_context, is_global_interview
from ...langgraph.node.writing import build_writing_materials
from ..catalog import CatalogError, CatalogService
from ..media import MediaService
from ..story import StoryRepository, StoryVersionConflict
from ..biography import BiographyService
from .repository import InterviewSessionRepository
from .memory_input import InterviewMemoryService, load_selected_topic
from .session import (
    InterviewError, InterviewSessionManager, ResumeMode, graph_config, has_pending_input,
    serialize_messages, validate_resume_mode,
)


def _model_account_error(exc: ModelAccountUnavailableError, session_id: str) -> InterviewError:
    return InterviewError(str(exc), 503, session_id, code=exc.code)


class InterviewService:
    def __init__(
        self, graph: CompiledStateGraph, media: MediaService,
        repository: InterviewSessionRepository,
        *, story_repository: StoryRepository,
        memory_inputs: InterviewMemoryService | None = None,
        catalog: CatalogService | None = None,
        biography_service: BiographyService | None = None,
    ) -> None:
        self.graph = graph
        self._media = media
        self._repository = repository
        self._stories = story_repository
        self._memory_inputs = memory_inputs
        self._catalog = catalog
        self._biography = biography_service
        self._session_manager = InterviewSessionManager(
            graph, media, repository, story_repository=story_repository,
            load_start_context=self._load_start_context,
        )
        self.sessions = self._session_manager.sessions

    # 对外入口：开始、读取、恢复、提交输入、重试、结束。

    def start(
        self, user_id: int, resume_mode: ResumeMode | None = None, *, topic_id: int | None = None,
        target_story_id: int | None = None,
    ) -> dict:
        """读取本人历史，创建会话并保存开场，等待页面提交输入。"""
        validate_resume_mode(resume_mode, allow_none=True)
        if target_story_id is not None and topic_id is None:
            raise InterviewError("补充故事需要原故事的话题", 422)
        try:
            selected_topic = load_selected_topic(topic_id, catalog=self._catalog) if topic_id is not None else None
        except CatalogError as exc:
            raise InterviewError(str(exc), exc.status_code) from exc
        except ValueError as exc:
            raise InterviewError(str(exc), 422) from exc
        if target_story_id is not None:
            return self._start_supplement(user_id, target_story_id, selected_topic, resume_mode)
        start_context = self._load_start_context(user_id, global_interview=selected_topic is None)
        start_context["interview_context"]["selected_topic"] = selected_topic
        if selected_topic is None:
            # Save an explicit scope so new global sessions remain distinct from old topicless records.
            start_context["interview_context"]["interview_scope"] = "global"
        try:
            record = self._repository.create(user_id, resume_mode=resume_mode)
        except psycopg.Error as exc:
            raise InterviewError("会话创建失败，请重试", 503) from exc

        session_id = str(record["id"])
        session_lock = self._session_manager.register(
            session_id, user_id, resume_mode=resume_mode,
        )
        with session_lock:
            try:
                state = self.graph.invoke({
                    "user_id": user_id, "source_session_id": session_id,
                    **start_context,
                }, graph_config(session_id))
            except ModelAccountUnavailableError as exc:
                raise _model_account_error(exc, session_id) from exc
            except Exception as exc:
                raise InterviewError("首问生成失败，请重试", 502, session_id) from exc
            self._session_manager.save(session_id)
        return {**_build_session_response(session_id, state), "resume_mode": resume_mode}

    def _start_supplement(self, user_id, story_id, selected_topic, resume_mode):
        try:
            revision, _created = self._stories.start_supplement(
                user_id, story_id, selected_topic['id'], resume_mode,
            )
        except LookupError as exc:
            raise InterviewError(str(exc), 404) from exc
        except ValueError as exc:
            raise InterviewError(str(exc), 409) from exc
        except psycopg.Error as exc:
            raise InterviewError('补充会话暂时无法创建，请重试', 503) from exc
        session_id = revision['source_session_id']
        # Registration and cold restoration share one lock; duplicate start requests reuse the same graph.
        with self._session_manager._restore_lock:
            if session_id not in self.sessions:
                record = self._repository.get(user_id, int(session_id))
                if record['context']:
                    self._session_manager._restore_session(record)
                self._session_manager.register(session_id, user_id, resume_mode=record['resume_mode'])
        with self.sessions[session_id]['lock']:
            state = self.graph.get_state(graph_config(session_id)).values
            if not state.get('messages'):
                start_context = self._load_start_context(user_id)
                start_context['interview_context']['selected_topic'] = selected_topic
                start_context['interview_context']['supplement_story'] = {
                    'story_id': story_id, 'title': revision['base_story']['title'],
                    'body': revision['base_story']['body'],
                }
                try:
                    state = self.graph.invoke({
                        'user_id': user_id, 'source_session_id': session_id,
                        'revision_id': revision['id'], 'target_story_id': story_id,
                        'revision_status': revision['status'], **start_context,
                    }, graph_config(session_id))
                except ModelAccountUnavailableError as exc:
                    raise _model_account_error(exc, session_id) from exc
                except Exception as exc:
                    raise InterviewError('补充开场暂时无法生成，请重试', 502, session_id) from exc
                self._session_manager.save(session_id)
            return {**_build_session_response(session_id, state),
                    'resume_mode': self.sessions[session_id]['resume_mode']}

    def _load_start_context(self, user_id: int, *, global_interview: bool = False) -> WorkflowState:
        """读取本场访谈记忆；恢复已有会话使用保存的记忆快照。"""
        try:
            history = self._stories.get_opening_history(user_id)
            if (history["has_story"] or self._repository.has_opening(user_id)
                    or self._repository.has_user_input(user_id)):
                mode = "returning_without_summary"
            else:
                mode = "first"
            opening_context: OpeningContext = {
                "mode": mode,
                # 新会话摘要只存在于故事记忆中；旧 recap 快照仍由原路径兼容。
                "previous_story_id": None,
                "previous_story_summary": "",
            }
            memory = dict(self._memory_inputs.build(user_id, history=history)) if self._memory_inputs else {}
            if not global_interview:
                memory.pop("previous_story_id", None)
            state: WorkflowState = {"opening_context": opening_context, "interview_context": memory}
        except psycopg.Error as exc:
            raise InterviewError("访谈历史读取失败，请重试", 503) from exc
        return state

    def get_session(self, user_id: int, session_id: str) -> dict:
        """读取当前会话；内存缺失时先恢复上次保存的消息历史。"""
        with self._session_manager.get_or_restore_lock(session_id, user_id):
            snapshot = self.graph.get_state(graph_config(session_id))
            result = _build_session_response(session_id, snapshot.values)
            next_node = snapshot.next[0] if snapshot.next else result.get("next_node")
            if next_node == "interview":
                if not snapshot.values.get("messages") or has_pending_input(snapshot.values):
                    result["status"] = "reply_pending"
                else:
                    next_node = None
            return {
                **result,
                "resume_mode": self.sessions[session_id]["resume_mode"],
                "messages": serialize_messages(snapshot.values),
                "next_node": next_node,
                "save_pending": self.sessions[session_id]["save_pending"],
            }

    def resume(self, user_id: int, session_id: str) -> dict:
        """保留原问答，重新读取并替换画像、事件索引和故事资料。"""
        with self._session_manager.get_or_restore_lock(session_id, user_id):
            self._require_voice_ready(session_id)
            try:
                latest = deepcopy(self._memory_inputs.build(user_id))
            except psycopg.Error as exc:
                raise InterviewError("访谈记忆读取失败，请重试", 503, session_id) from exc

            config = graph_config(session_id)
            state = self.graph.get_state(config).values
            opening = deepcopy(next(message for message in state["messages"] if isinstance(message, AIMessage)))
            context = opening.additional_kwargs.get("interview_context") or {}
            context["user_profile"] = latest["user_profile"]
            context["life_event_context"] = latest["life_event_context"]
            opening.additional_kwargs["interview_context"] = context
            self.graph.update_state(config, {
                "messages": [opening], "interview_context": deepcopy(context),
            }, as_node="interview")
            self._session_manager.save(session_id)
            return {
                **_build_session_response(session_id, self.graph.get_state(config).values),
                "resume_mode": self.sessions[session_id]["resume_mode"],
            }

    def update_mode(self, user_id: int, session_id: str, resume_mode: ResumeMode) -> dict:
        """保存用户明确选择的恢复模式，不修改图状态或触发访谈回复。"""
        validate_resume_mode(resume_mode)
        with self._session_manager.get_or_restore_lock(session_id, user_id):
            self._require_voice_ready(session_id)
            try:
                record = self._repository.update_mode(user_id, int(session_id), resume_mode)
            except psycopg.Error as exc:
                raise InterviewError("聊天模式保存失败，请重试", 503) from exc
            if record is None:
                raise InterviewError("会话不存在或访谈已结束", 409)
            self.sessions[session_id]["resume_mode"] = record["resume_mode"]
            return {"session_id": session_id, "resume_mode": record["resume_mode"]}

    def upload_photo(
        self, user_id: int, session_id: str, stream: BinaryIO, text: str = "",
    ) -> dict:
        """保存图片，再作为本轮用户输入交给同一个访谈节点。"""
        with self._session_manager.get_or_restore_lock(session_id, user_id):
            self._session_manager.require_saved(session_id)
            snapshot = self.graph.get_state(graph_config(session_id))
            state = snapshot.values
            if state.get("interview_finished"):
                raise InterviewError("访谈已结束", 409)
            if snapshot.next != ("interview",) or not state.get("messages") or has_pending_input(state):
                raise InterviewError("本轮回复未完成，请先重试", 409)
            media_id = self._media.upload(user_id, session_id, stream)
            return self._run_interview(session_id, text, media_id=media_id)

    def submit_text(self, user_id: int, session_id: str, text: str) -> dict:
        """提交文字，每次输入执行一轮访谈。"""
        if not text.strip():
            raise InterviewError("请输入文字或上传图片", 422)
        with self._session_manager.get_or_restore_lock(session_id, user_id):
            return self._run_interview(session_id, text)

    def require_voice_ready(self, user_id: int, session_id: str) -> None:
        """通话准备／首次启动时核验实际图状态，不能只看上次数据库快照。"""
        with self._session_manager.get_or_restore_lock(session_id, user_id):
            self._require_voice_ready(session_id)

    def submit_voice(
        self, user_id: int, session_id: str, text: str, *, timeout_seconds: float | None = None,
    ) -> dict:
        """语音转写复用访谈图；桥接层按腾讯请求 ID 去重，成功只返回已保存回复。"""
        if not isinstance(text, str) or not text.strip():
            raise InterviewError("请输入有效的语音讲述", 422)
        with self._session_manager.get_or_restore_lock(session_id, user_id):
            self._require_voice_ready(session_id)
            # 在腾讯等待上限内给出结果，为快照保存及网络传输预留时间。
            # ContextVar 随 LangGraph 执行上下文传播，不影响并发的文字请求。
            with qwen_timeout_limit(timeout_seconds):
                return self._run_interview(session_id, text)

    def _require_voice_ready(self, session_id: str) -> None:
        self._session_manager.require_saved(session_id)
        snapshot = self.graph.get_state(graph_config(session_id))
        if snapshot.values.get("interview_finished"):
            raise InterviewError("访谈已结束", 409)
        if (snapshot.next != ("interview",) or not snapshot.values.get("messages")
                or has_pending_input(snapshot.values)):
            raise InterviewError("上一轮回复尚未完成，请先挂断并继续处理上一条", 409)

    def retry(self, user_id: int, session_id: str) -> dict:
        """先补存失败的快照；仍有待回复输入时继续生成，不追加用户消息。"""
        with self._session_manager.get_or_restore_lock(session_id, user_id):
            if self.sessions[session_id]["save_pending"]:
                self._session_manager.save(session_id)
                state = self.graph.get_state(graph_config(session_id)).values
                if not has_pending_input(state):
                    return _build_session_response(session_id, state)

            snapshot = self.graph.get_state(graph_config(session_id))
            if snapshot.next != ("interview",) or (
                snapshot.values.get("messages") and not has_pending_input(snapshot.values)
            ):
                raise InterviewError("当前没有需要重试的回复", 409)
            opening = snapshot.values.get("opening_context", {})
            if not snapshot.values.get("messages") and opening.get("mode") == "first":
                try:
                    # 首问失败后可能已在另一场看到介绍，只复核开场模式，不重读记忆。
                    if self._repository.has_opening(user_id):
                        self.graph.update_state(graph_config(session_id), {
                            "opening_context": {**opening, "mode": "returning_without_summary"},
                        }, as_node="interview")
                except psycopg.Error as exc:
                    raise InterviewError("访谈历史读取失败，请重试", 503) from exc
            return self._run_interview(session_id)

    def finish(self, user_id: int, session_id: str, *, rebase: bool = False) -> dict:
        """用户要求成文后保存故事、更新记忆，并将故事融入传记。"""
        with self._session_manager.get_or_restore_lock(session_id, user_id):
            self._session_manager.require_saved(session_id)
            config = graph_config(session_id)
            snapshot = self.graph.get_state(config)
            if rebase:
                revision_id = snapshot.values.get('revision_id')
                if not revision_id:
                    raise InterviewError('当前讲述不需要重新整理', 409, session_id)
                try:
                    self._stories.rebase_revision(user_id, revision_id)
                except ValueError as exc:
                    raise InterviewError(str(exc), 409, session_id) from exc
                self.graph.update_state(config, {'revision_status': 'pending'}, as_node='interview')
                snapshot = self.graph.get_state(config)
            if not is_global_interview(snapshot.values) and interview_chapter_id(snapshot.values) is None and not (
                snapshot.values.get("story_id")
                and type(snapshot.values.get("chapter_id")) is int
                and snapshot.values["chapter_id"] > 0
            ):
                raise InterviewError("这段旧访谈没有所属章节，请从章节下的话题开始新访谈；原讲述仍保留", 409, session_id)
            if not snapshot.values.get("interview_finished"):
                if (snapshot.next != ("interview",) or not snapshot.values.get("messages")
                        or has_pending_input(snapshot.values)):
                    raise InterviewError("本轮回复未完成，请先重试", 409)
                try:
                    build_writing_materials(snapshot.values)
                except ValueError as exc:
                    raise InterviewError(str(exc), 409, session_id) from exc

                self.graph.update_state(config, {"interview_finished": True}, as_node="interview")
                self._session_manager.save(session_id)
                if snapshot.values.get('revision_id'):
                    self._stories.mark_revision_pending(user_id, snapshot.values['revision_id'])
                snapshot = self.graph.get_state(config)

            if snapshot.next in (
                ("writing",), ("memory_update",), ("summary",),
            ):
                try:
                    self.graph.invoke(None, config)
                except StoryVersionConflict as exc:
                    self.graph.update_state(config, {'revision_status': 'conflict'}, as_node='interview')
                    raise InterviewError(str(exc), 409, session_id, code='STORY_VERSION_CONFLICT') from exc
                except ModelAccountUnavailableError as exc:
                    raise _model_account_error(exc, session_id) from exc
                except Exception as exc:
                    pending = self.graph.get_state(config).next
                    step = {
                        ("memory_update",): "记忆更新",
                        ("summary",): "摘要",
                    }.get(pending)
                    if step:
                        raise InterviewError(
                            f"故事已保存，{step}尚未完成，请点击继续整理重试",
                            503 if isinstance(exc, psycopg.Error) else 502, session_id,
                        ) from exc
                    raise InterviewError(
                        '故事暂时未能整理，讲述已保留，请继续整理重试',
                        503 if isinstance(exc, psycopg.Error) else 502, session_id,
                    ) from exc
                snapshot = self.graph.get_state(config)
            if (self._biography is not None
                    and _build_session_response(session_id, snapshot.values)["status"] == "completed"):
                try:
                    self._biography.merge_story(user_id, snapshot.values)
                except ModelAccountUnavailableError as exc:
                    raise _model_account_error(exc, session_id) from exc
                except Exception as exc:
                    raise InterviewError(
                        '故事已保存，传记更新尚未完成，请点击继续整理重试',
                        503 if isinstance(exc, psycopg.Error) else 502, session_id,
                    ) from exc
            return _build_session_response(session_id, snapshot.values)

    # 轮次执行与保存：新输入只追加一次；失败重试沿用图中已有的用户消息。

    def _run_interview(
        self, session_id: str, text: str | None = None, *,
        media_id: int | None = None,
    ) -> dict:
        """有 text 时追加新输入；否则恢复失败的模型调用，不追加消息。"""
        self._session_manager.require_saved(session_id)
        config = graph_config(session_id)
        snapshot = self.graph.get_state(config)
        if snapshot.values.get("interview_finished"):
            raise InterviewError("访谈已结束", 409)
        if text is not None and (
            snapshot.next != ("interview",) or not snapshot.values.get("messages")
            or has_pending_input(snapshot.values)
        ):
            raise InterviewError("本轮回复未完成，请先重试", 409)

        update: WorkflowState | None = None
        if text is not None:
            media_ids = [media_id] if media_id is not None else []
            update = {"messages": [HumanMessage(
                id=next_message_id(snapshot.values["messages"]),
                content=text.strip(), additional_kwargs={"media_ids": media_ids},
            )]}
            if media_id is not None:
                update["image_urls"] = {
                    **snapshot.values.get("image_urls", {}),
                    media_id: self._session_manager.load_photo_data_url(
                        snapshot.values["user_id"], session_id, media_id,
                    ),
                }

        try:
            if update is not None:
                self.graph.update_state(config, update, as_node="interview")
                # 先保留已收到的讲述；模型失败或进程重启后仍可重试这一轮。
                self._session_manager.save(session_id)
            state = self.graph.invoke(None, config)
        except InterviewError:
            raise
        except ModelAccountUnavailableError as exc:
            raise _model_account_error(exc, session_id) from exc
        except Exception as exc:
            raise InterviewError("本轮回复失败，请重试", 502) from exc
        self._session_manager.save(session_id)
        return _build_session_response(session_id, state)


def _build_session_response(session_id: str, state: WorkflowState) -> dict:
    """根据当前状态构建响应；这里只描述进度，流程跳转仍由图控制。"""
    context = saved_interview_context(state.get("messages", []))
    if context is None:
        context = state.get("interview_context", {})
    topic = context.get("selected_topic")
    selected_topic = (
        {key: topic[key] for key in ("id", "chapter_id", "title", "description")}
        if isinstance(topic, dict)
        and all(type(topic.get(key)) is int and topic[key] > 0 for key in ("id", "chapter_id"))
        and all(isinstance(topic.get(key), str) for key in ("title", "description"))
        else None
    )
    if selected_topic is not None and isinstance(topic.get("chapter_title"), str):
        selected_topic["chapter_title"] = topic["chapter_title"]
    common = {
        "session_id": session_id, "selected_topic": selected_topic,
        "interview_scope": "global" if context.get("interview_scope") == "global" else "chapter" if selected_topic else None,
    }
    if state.get('target_story_id'):
        common['target_story_id'] = state['target_story_id']
    if state.get('revision_status') == 'conflict':
        return {**common, 'status': 'revision_conflict', 'next_node': 'writing'}
    if not state.get("messages"):
        return {**common, "status": "reply_pending", "next_node": "interview"}
    if (
        state.get("interview_finished")
        and state.get("story_id")
        and (is_global_interview(state) or (type(state.get("chapter_id")) is int and state["chapter_id"] > 0))
        and state.get("profile_processed", True)
        and state.get("life_event_processed", True)
        and isinstance(state.get("summary"), str) and state["summary"].strip()
    ):
        return {
            **common,
            "status": "completed",
            "next_node": None,
            "story_id": state["story_id"],
            "title": state["title"],
            "body": state["body"],
            "chapter_id": state.get("chapter_id"),
            **({"source_session_id": state["source_session_id"], "photo_layout": state["photo_layout"]}
               if state.get("photo_layout") else {}),
        }
    if state.get("interview_finished"):
        if "story_id" not in state or (state.get("chapter_id") is None and not is_global_interview(state)):
            next_node = "writing"
        elif not state.get("profile_processed", True) or not state.get("life_event_processed", True):
            next_node = "memory_update"
        else:
            next_node = "summary"
        return {
            **common,
            "status": "writing_pending",
            "next_node": next_node,
        }
    if "assistant_text" in state:
        assistant_message_id = next((
            message.id for message in reversed(state.get("messages", []))
            if isinstance(message, AIMessage) and message.content == state["assistant_text"]
        ), None)
        return {
            **common,
            "status": "interview_replied",
            "next_node": None,
            "assistant_text": state["assistant_text"],
            "assistant_message_id": assistant_message_id,
        }
    return {
        **common,
        "status": "awaiting_first_input",
        "next_node": None,
        "opening_text": state["opening_text"],
    }

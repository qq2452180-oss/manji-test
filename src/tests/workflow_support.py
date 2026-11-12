"""访谈与成文工作流的离线测试替身；模型、媒体与持久化均在内存中。"""

from copy import deepcopy
from datetime import datetime, timezone
import socket
from types import SimpleNamespace
from unittest.mock import Mock

from langchain_core.messages import HumanMessage, convert_to_messages
import psycopg

from src.langgraph.graph import build_graph
from src.service.interview import InterviewService
from src.service.catalog import CatalogService
from src.service.biography import BiographyService


class FakeSessionRepository:
    """保存独立的消息快照，供重建服务后的恢复测试复用。"""

    def __init__(self):
        self.rows = {}
        self.save = Mock(side_effect=self._save)
        self.get = Mock(side_effect=self._get)
        self.has_opening = Mock(side_effect=self._has_opening)
        self.has_user_input = Mock(side_effect=self._has_user_input)
        self.update_mode = Mock(side_effect=self._update_mode)

    def create(self, user_id, resume_mode=None):
        session_id = len(self.rows) + 1
        now = datetime.now(timezone.utc)
        self.rows[session_id] = {
            "id": session_id, "user_id": user_id, "context": [],
            "resume_mode": resume_mode, "create_time": now,
            "update_time": now, "finish_time": None,
        }
        return deepcopy(self.rows[session_id])

    def _get(self, user_id, session_id):
        row = self.rows.get(session_id)
        return deepcopy(row) if row and row["user_id"] == user_id else None

    def _save(self, user_id, session_id, context, finished=False):
        row = self._get(user_id, session_id)
        if row is None:
            return None
        row["context"] = deepcopy(context)
        row["update_time"] = datetime.now(timezone.utc)
        if finished and row["finish_time"] is None:
            row["finish_time"] = row["update_time"]
        self.rows[session_id] = row
        return deepcopy(row)

    def _has_opening(self, user_id):
        return any(
            message['type'] == 'ai' and isinstance(message['data'].get('content'), str)
            and message['data']['content'].strip()
            for row in self.rows.values() if row['user_id'] == user_id
            for message in row['context']
        )

    def _has_user_input(self, user_id):
        for row in self.rows.values():
            if row["user_id"] != user_id:
                continue
            for message in row["context"]:
                if message["type"] != "human":
                    continue
                data = message["data"]
                content = data.get("content")
                if isinstance(content, str) and content.strip():
                    return True
                if data.get("additional_kwargs", {}).get("media_ids"):
                    return True
        return False

    def _update_mode(self, user_id, session_id, resume_mode):
        row = self._get(user_id, session_id)
        if row is None or row["finish_time"] is not None:
            return None
        row["resume_mode"] = resume_mode
        self.rows[session_id] = row
        return deepcopy(row)


class FakeStoryRepository:
    """提供可单独设定的开场历史，以及可追踪调用的故事保存操作。"""

    def __init__(self):
        self.histories = {}
        self.stories = {}
        self.get_opening_history = Mock(side_effect=self._get_opening_history)
        self.create = Mock(side_effect=self._create)
        self.get_by_session = Mock(side_effect=self._get_by_session)
        self.get_for_summary = Mock(side_effect=self._get_story)
        self.restore_chapter = Mock(side_effect=self._restore_chapter)
        self.set_summary = Mock(side_effect=self._set_summary)
        self.get_postprocessing_status = Mock(side_effect=self._get_postprocessing_status)

    def _get_opening_history(self, user_id):
        return deepcopy(self.histories.get(user_id, {
            "has_story": False, "previous_story": None,
        }))

    def _create(self, user_id, title, body, *, chapter_id, source_session_id=None, photo_layout=None):
        assert chapter_id is None or (type(chapter_id) is int and chapter_id > 0)
        story_id = 73 + len(self.stories)
        self.stories[story_id] = {
            "story_id": story_id, "user_id": user_id, "title": title, "body": body,
            "chapter_id": chapter_id, "summary": "", "source_session_id": source_session_id,
            "photo_layout": deepcopy(photo_layout or []),
            "profile_processed": False, "life_event_processed": False,
        }
        return story_id

    def _get_story(self, user_id, story_id):
        row = self.stories.get(story_id)
        return deepcopy(row) if row and row["user_id"] == user_id else None

    def _get_by_session(self, user_id, source_session_id):
        return next((deepcopy(row) for row in self.stories.values()
                     if row["user_id"] == user_id
                     and row["source_session_id"] == source_session_id), None)

    def _restore_chapter(self, user_id, story_id, chapter_id):
        row = self.stories[story_id]
        assert row["user_id"] == user_id
        assert type(chapter_id) is int and chapter_id > 0
        if row["chapter_id"] is None:
            row["chapter_id"] = chapter_id
        return row["chapter_id"]

    def _set_summary(self, *, user_id, story_id, summary):
        row = self.stories[story_id]
        assert row["user_id"] == user_id
        row["summary"] = row["summary"] or summary
        return row["summary"]

    def _get_postprocessing_status(self, user_id, story_id):
        row = self.stories[story_id]
        assert row["user_id"] == user_id
        return {key: row[key] for key in ("profile_processed", "life_event_processed")}


class FakeBiographyRepository:
    """按用户保存当前传记正文。"""

    def __init__(self):
        self.rows = {}
        self.prepare = Mock(side_effect=self._prepare)
        self.save = Mock(side_effect=self._save)
        self.get = Mock(side_effect=self._get)

    def _get(self, user_id):
        return deepcopy(self.rows.get(user_id))

    def _prepare(self, user_id, story_id, *, revision_id=None):
        return {
            **(self._get(user_id) or {"body": ""}),
            "story_life_event_id": None, "story_chapter": None, "life_events": [], "story_index": [],
        }

    def _save(self, user_id, body):
        self.rows[user_id] = {
            "body": body, "updated_time": datetime.now(timezone.utc),
        }
        return self._get(user_id)


def make_interview_flow(monkeypatch, *, with_biography=False):
    """组装真实图和服务，暴露模型 Mock 与存储，供故障及冷恢复测试调整。"""
    forbidden = Mock(side_effect=AssertionError("工作流测试不可访问网络或数据库"))
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(psycopg, "connect", forbidden)

    def interview_reply(messages, **_kwargs):
        if any(isinstance(message, HumanMessage) and message.id for message in convert_to_messages(messages)):
            return "后来呢？"
        return "想聊哪段往事？"

    model = Mock(side_effect=interview_reply)
    writer = Mock(return_value='{"title": "老家的日子", "body": "我小时候住在乡下。"}')
    summarizer = Mock(return_value='{"summary": "作者讲述了小时候住在乡下的经历。"}')
    monkeypatch.setattr("src.langgraph.node.interview.call_qwen", model)
    monkeypatch.setattr("src.langgraph.node.writing.call_qwen", writer)
    monkeypatch.setattr("src.langgraph.node.summary.call_qwen", summarizer)
    biography_repository = FakeBiographyRepository() if with_biography else None
    merger = Mock(return_value='{"body": "我小时候住在乡下，后来到城里学手艺。"}')
    if with_biography:
        monkeypatch.setattr("src.service.biography.service.call_qwen", merger)
    media = Mock()
    media.upload.return_value = 17
    media.read.return_value = (b"original photo bytes", "image/png")
    repository = FakeSessionRepository()
    story_repository = FakeStoryRepository()
    topic = {"id": 13, "chapter_id": 2, "chapter_title": "早年生活与长大的地方", "title": "住过的地方", "description": "小时候的住处与日常。"}
    catalog = Mock(spec=CatalogService)
    catalog.get_enabled_topic.side_effect = lambda topic_id: deepcopy(topic) if topic_id == topic["id"] else None
    biography_service = BiographyService(biography_repository) if with_biography else None
    biography_options = {"biography_service": biography_service} if with_biography else {}
    graph = build_graph(story_repository=story_repository)
    service = InterviewService(
        graph, media, repository, story_repository=story_repository, catalog=catalog,
        **biography_options,
    )
    return SimpleNamespace(
        service=service, graph=graph, model=model,
        writer=writer, summarizer=summarizer, topic=topic, catalog=catalog,
        media=media,
        repository=repository, story_repository=story_repository,
        stories=story_repository.stories, save_summary=story_repository._set_summary,
        biography_repository=biography_repository, biography_service=biography_service, merger=merger,
    )

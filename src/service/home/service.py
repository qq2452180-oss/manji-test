"""读取主页和传记、修改已完成故事，不恢复访谈图或调用模型。"""

import psycopg

from ..interview.repository import InterviewSessionRepository
from ..story import StoryRepository, StoryVersionConflict
from ..biography import BiographyService
from .progress import TopicProgressRepository


class HomeError(ValueError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class HomeService:
    def __init__(
        self, interviews: InterviewSessionRepository, stories: StoryRepository,
        *, progress: TopicProgressRepository | None = None,
        biography_service: BiographyService | None = None,
    ) -> None:
        self._interviews = interviews
        self._stories = stories
        self._progress = progress
        self._biography = biography_service

    def get_home(self, user_id: int) -> dict:
        try:
            interview = self._interviews.latest_unfinished(user_id)
            stories = self._stories.list_recent(user_id)
            topic_progress = self._progress.list_progress(user_id) if self._progress else []
        except psycopg.Error as exc:
            raise HomeError("主页暂时无法读取，请稍后重试", 503) from exc
        unfinished = None
        if interview is not None:
            preview = next((
                message["data"]["content"] for message in reversed(interview["context"])
                if message["type"] == "ai"
            ), "")
            unfinished = {
                "session_id": str(interview["id"]),
                "resume_mode": interview.get("resume_mode"),
                "update_time": interview["update_time"],
                "preview": preview[:100],
                "needs_processing": bool(interview.get("needs_processing", False)),
            }
        return {"unfinished_interview": unfinished, "stories": stories, "topic_progress": topic_progress}

    def get_story(self, user_id: int, story_id: int) -> dict:
        try:
            story = self._stories.get_completed(user_id, story_id)
            if story is not None:
                self._add_story_context(user_id, story)
        except psycopg.Error as exc:
            raise HomeError("故事暂时无法读取，请稍后重试", 503) from exc
        if story is None:
            raise HomeError("故事不存在", 404)
        return story

    def _add_story_context(self, user_id: int, story: dict) -> None:
        if self._progress is None:
            return
        story_id = story["story_id"]
        story["selected_topic"] = self._progress.story_topic(user_id, story)
        story["active_supplement"] = self._stories.get_active_supplement(user_id, story_id)
        story["source_sessions"] = self._stories.list_story_sessions(user_id, story_id)
        pending = next((session for session in story["source_sessions"]
                        if session["status"] == "organizing"), None)
        story["pending_processing"] = {"session_id": pending["session_id"]} if pending else None

    def update_story(
        self, user_id: int, story_id: int, title: str, body: str,
        photo_layout: list[dict], *, expected_version: int | None = None,
    ) -> dict:
        try:
            story = self._stories.update_completed(
                user_id, story_id, title, body, photo_layout, expected_version=expected_version,
            )
            if story is not None:
                self._add_story_context(user_id, story)
        except StoryVersionConflict as exc:
            raise HomeError(str(exc), 409) from exc
        except ValueError as exc:
            raise HomeError(str(exc), 422) from exc
        except psycopg.Error as exc:
            raise HomeError("故事暂时无法保存，请稍后重试", 503) from exc
        if story is None:
            raise HomeError("故事不存在", 404)
        return story

    def get_biography(self, user_id: int) -> dict:
        try:
            chapters = self._stories.list_user_chapters(user_id)
            biography = self._biography.get(user_id) if self._biography is not None else None
        except psycopg.Error as exc:
            raise HomeError("传记暂时无法读取，请稍后重试", 503) from exc
        return {
            "body": biography["body"] if biography else None,
            "last_story_time": max(
                (chapter["last_story_time"] for chapter in chapters), default=None,
            ),
            "chapters": [
                {key: chapter[key] for key in ("chapter_id", "title", "story_count")}
                for chapter in chapters
            ],
        }

    def get_chapter(self, user_id: int, chapter_id: int) -> dict:
        try:
            chapter = self._stories.get_chapter(user_id, chapter_id)
        except psycopg.Error as exc:
            raise HomeError("章节暂时无法读取，请稍后重试", 503) from exc
        if chapter is None:
            raise HomeError("章节不存在", 404)
        return chapter

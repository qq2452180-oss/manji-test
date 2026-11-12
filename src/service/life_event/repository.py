"""人生经历索引的数据库读写，以及索引更新与故事关联的事务保存。"""

import psycopg
from psycopg.rows import dict_row

from .schema import LifeEventSuggestion


class LifeEventRepository:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self):
        if not self._database_url:
            raise psycopg.OperationalError("MANJILU_DATABASE_URL is not configured")
        return psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=5)

    def get_life_events(self, user_id: int) -> list[dict]:
        """按 ID 顺序返回当前用户的经历索引；没有记录时返回空列表。"""
        with self._connect() as connection:
            return connection.execute(
                "SELECT id, title, summary, time_text, life_stage, status FROM life_events "
                "WHERE user_id = %s ORDER BY id",
                (user_id,),
            ).fetchall()

    def save_suggestion(
        self, user_id: int, story_id: int, suggestion: LifeEventSuggestion, *, once: bool = False,
        revision_id: int | None = None,
    ) -> dict:
        """保存建议及故事关联；once 模式一并保存处理进度，独立调用的 skip 不访问数据库。"""
        result = {**suggestion.model_dump(), "story_id": story_id}
        once = once or revision_id is not None
        if suggestion.action == "skip" and not once:
            return result

        fields = ("title", "summary", "life_stage", "time_text", "status")
        values = tuple(getattr(suggestion, field) for field in fields)
        with self._connect() as connection:
            revision = None
            if revision_id is not None:
                # Applying a draft also locks story before revision; retain that order.
                owned_story = connection.execute(
                    "SELECT id FROM story WHERE id = %s AND user_id = %s FOR UPDATE",
                    (story_id, user_id),
                ).fetchone()
                if owned_story is None:
                    raise ValueError("未找到该用户的故事")
                revision = connection.execute(
                    "SELECT life_event_processed, applied_version, status FROM story_revisions "
                    "WHERE id = %s AND user_id = %s AND story_id = %s FOR UPDATE",
                    (revision_id, user_id, story_id),
                ).fetchone()
                if revision is None or revision["applied_version"] is None or revision["status"] not in {"applied", "completed"}:
                    raise ValueError("未找到已保存的故事补充")
                story = revision
            elif once:
                story = connection.execute(
                    "SELECT life_event_processed FROM story "
                    "WHERE id = %s AND user_id = %s FOR UPDATE",
                    (story_id, user_id),
                ).fetchone()
                if story is None:
                    raise ValueError("未找到该用户的故事")
            if once:
                if story["life_event_processed"]:
                    return {
                        "action": "skip", "event_id": None, "title": None, "summary": None,
                        "life_stage": None, "time_text": None, "status": None,
                        "reason": "本篇故事已完成经历归纳", "story_id": story_id,
                    }
                if suggestion.action == "skip":
                    if revision_id is not None:
                        connection.execute(
                            "UPDATE story_revisions SET life_event_processed = TRUE, update_time = CURRENT_TIMESTAMP "
                            "WHERE id = %s AND user_id = %s AND story_id = %s",
                            (revision_id, user_id, story_id),
                        )
                    else:
                        connection.execute(
                            "UPDATE story SET life_event_processed = TRUE WHERE id = %s AND user_id = %s",
                            (story_id, user_id),
                        )
                    return result

            if suggestion.action == "create":
                event = connection.execute(
                    "INSERT INTO life_events (user_id, title, summary, life_stage, time_text, status) "
                    "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                    (user_id, *values),
                ).fetchone()
                event_id = event["id"]
            else:
                event_id = suggestion.event_id
                event = connection.execute(
                    "SELECT title, summary, life_stage, time_text, status FROM life_events "
                    "WHERE id = %s AND user_id = %s",
                    (event_id, user_id),
                ).fetchone()
                if event is None:
                    raise ValueError("未找到该用户的经历")
                if any(event[field] != getattr(suggestion, field) for field in fields):
                    event = connection.execute(
                        "UPDATE life_events SET title = %s, summary = %s, life_stage = %s, "
                        "time_text = %s, status = %s, updated_at = CURRENT_TIMESTAMP "
                        "WHERE id = %s AND user_id = %s RETURNING id",
                        (*values, event_id, user_id),
                    ).fetchone()
                    if event is None:
                        raise ValueError("未找到该用户的经历")

            if revision_id is not None:
                connection.execute(
                    "UPDATE story_revisions SET life_event_id = %s, life_event_processed = TRUE, "
                    "update_time = CURRENT_TIMESTAMP WHERE id = %s AND user_id = %s AND story_id = %s",
                    (event_id, revision_id, user_id, story_id),
                )
                # A delayed old revision must not replace a newer story's association.
                connection.execute(
                    "UPDATE story SET life_event_id = %s "
                    "WHERE id = %s AND user_id = %s AND version = %s",
                    (event_id, story_id, user_id, revision["applied_version"]),
                )
            else:
                completion = ", life_event_processed = TRUE" if once else ""
                story = connection.execute(
                    "UPDATE story SET life_event_id = %s" + completion
                    + " WHERE id = %s AND user_id = %s RETURNING id",
                    (event_id, story_id, user_id),
                ).fetchone()
                if story is None:
                    raise ValueError("未找到该用户的故事")

        return {**result, "event_id": event_id}

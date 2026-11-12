"""读写每个用户的传记全文。"""

import psycopg
from psycopg.rows import dict_row

from ..story.scope import readable_story_sql


def _chapter_context(story: dict) -> dict | None:
    if story["chapter_id"] is None:
        return None
    return {
        "id": story["chapter_id"], "title": story["chapter_title"],
        "sort_order": story["chapter_sort_order"],
    }


class BiographyRepository:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self):
        if not self._database_url:
            raise psycopg.OperationalError("MANJILU_DATABASE_URL is not configured")
        return psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=5)

    def get(self, user_id: int) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "SELECT body, updated_time FROM biography WHERE user_id = %s", (user_id,),
            ).fetchone()

    def prepare(self, user_id: int, story_id: int, *, revision_id=None) -> dict:
        """读取旧稿、最新经历索引和故事归属，供本次融合使用。"""
        with self._connect() as connection:
            owned = connection.execute(
                "SELECT story.life_event_id, story.version, chapter.id AS chapter_id, "
                "chapter.title AS chapter_title, chapter.sort_order AS chapter_sort_order "
                "FROM story LEFT JOIN chapter ON chapter.id = story.chapter_id "
                "WHERE story.user_id = %s AND story.id = %s",
                (user_id, story_id),
            ).fetchone()
            if owned is None:
                raise ValueError("未找到该用户的故事")
            story_life_event_id = owned["life_event_id"]
            if revision_id is not None:
                revision = connection.execute(
                    "SELECT life_event_id, applied_version, status FROM story_revisions "
                    "WHERE id = %s AND user_id = %s AND story_id = %s",
                    (revision_id, user_id, story_id),
                ).fetchone()
                if (revision is None or revision["applied_version"] is None
                        or revision["status"] not in {"applied", "completed"}):
                    raise ValueError("未找到已保存的故事补充")
                story_life_event_id = revision["life_event_id"]
                if story_life_event_id is None and owned["version"] == revision["applied_version"]:
                    story_life_event_id = owned["life_event_id"]
            saved = connection.execute(
                "SELECT body, updated_time FROM biography WHERE user_id = %s", (user_id,),
            ).fetchone()
            life_events = connection.execute(
                "SELECT id, title, summary, life_stage, time_text FROM life_events "
                "WHERE user_id = %s ORDER BY id", (user_id,),
            ).fetchall()
            # 已有传记时只补充历史故事的目录，不重复传入所有故事全文。
            historical_body = ", story.body" if saved is None else ""
            stories = connection.execute(
                "SELECT story.id AS story_id, story.title, story.summary, story.life_event_id, "
                "chapter.id AS chapter_id, chapter.title AS chapter_title, "
                "chapter.sort_order AS chapter_sort_order"
                + historical_body + " FROM story "
                "LEFT JOIN chapter ON chapter.id = story.chapter_id "
                f"WHERE story.user_id = %s AND story.id <> %s AND {readable_story_sql()} "
                "ORDER BY chapter.sort_order NULLS LAST, chapter.id NULLS LAST, story.create_time, story.id",
                (user_id, story_id),
            ).fetchall()
        current = saved if saved is not None else {
            "body": "\n\n".join(f"{story['title']}\n\n{story['body']}" for story in stories),
        }
        event_ids = {event["id"] for event in life_events}
        return {
            **current,
            "story_life_event_id": story_life_event_id if story_life_event_id in event_ids else None,
            "story_chapter": _chapter_context(owned),
            "life_events": life_events,
            "story_index": [{
                "story_id": story["story_id"], "title": story["title"], "summary": story["summary"],
                "life_event_id": story["life_event_id"] if story["life_event_id"] in event_ids else None,
                "chapter": _chapter_context(story),
            } for story in stories],
        }

    def save(self, user_id: int, body: str) -> dict:
        if not isinstance(body, str) or not body.strip():
            raise ValueError("传记正文不能为空")
        with self._connect() as connection:
            return connection.execute(
                "INSERT INTO biography (user_id, body) VALUES (%s, %s) "
                "ON CONFLICT (user_id) DO UPDATE SET body = EXCLUDED.body, updated_time = CURRENT_TIMESTAMP "
                "RETURNING body, updated_time",
                (user_id, body.strip()),
            ).fetchone()

"""按保存的话题快照读取个人进度，不恢复访谈图或调用模型。"""

import psycopg
from psycopg.rows import dict_row


TOPIC_SNAPSHOT = """(
    SELECT entry.message #> '{data,additional_kwargs,interview_context,selected_topic}'
    FROM jsonb_array_elements(session.context) WITH ORDINALITY AS entry(message, position)
    WHERE entry.message->>'type' = 'ai'
    ORDER BY entry.position LIMIT 1
)"""


def valid_topic(value: object, chapter_id: int | None = None) -> dict | None:
    if not isinstance(value, dict):
        return None
    if any(type(value.get(key)) is not int or not 0 < value[key] <= 2**63 - 1
           for key in ("id", "chapter_id")):
        return None
    if chapter_id is not None and value["chapter_id"] != chapter_id:
        return None
    return value


def summarize_progress(sessions: list[dict], stories: list[dict], supplements: list[dict]) -> list[dict]:
    """输入按更新时间倒序；已有正文优先，同题旧故事不因近期窗口消失。"""
    by_session = {str(row["session_id"]): row for row in sessions}
    active = {str(row["story_id"]): row for row in supplements if row["status"] != "completed"}
    progress = {}
    for story in stories:
        source = by_session.get(str(story["source_session_id"]))
        topic = valid_topic(source.get("selected_topic"), story["chapter_id"]) if source else None
        if topic is None:
            continue
        key = (topic["chapter_id"], topic["id"])
        supplement = active.get(str(story["story_id"]))
        progress.setdefault(key, {
            "topic_id": topic["id"], "chapter_id": topic["chapter_id"], "status": "told",
            "story_id": story["story_id"],
            "session_id": str(supplement["source_session_id"]) if supplement else None,
        })
    for session in sessions:
        topic = valid_topic(session["selected_topic"])
        if topic is None:
            continue
        key = (topic["chapter_id"], topic["id"])
        progress.setdefault(key, {
            "topic_id": topic["id"], "chapter_id": topic["chapter_id"],
            "status": "organizing" if session["finish_time"] is not None else "in_progress",
            "story_id": None, "session_id": str(session["session_id"]),
        })
    return list(progress.values())


class TopicProgressRepository:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self):
        if not self._database_url:
            raise psycopg.OperationalError("MANJILU_DATABASE_URL is not configured")
        return psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=5)

    def list_progress(self, user_id: int) -> list[dict]:
        with self._connect() as connection:
            sessions = connection.execute(
                f"SELECT session.id AS session_id, session.finish_time, {TOPIC_SNAPSHOT} AS selected_topic "
                "FROM interview_sessions AS session WHERE session.user_id = %s "
                "ORDER BY session.update_time DESC, session.id DESC", (user_id,),
            ).fetchall()
            stories = connection.execute(
                "SELECT id AS story_id, source_session_id, chapter_id FROM story "
                "WHERE user_id = %s AND chapter_id IS NOT NULL AND body ~ '[^[:space:]]' "
                "ORDER BY updated_time DESC, id DESC", (user_id,),
            ).fetchall()
            supplements = connection.execute(
                "SELECT story_id, source_session_id, status FROM story_revisions "
                "WHERE user_id = %s AND status <> 'completed'", (user_id,),
            ).fetchall()
        return summarize_progress(sessions, stories, supplements)

    def story_topic(self, user_id: int, story: dict) -> dict | None:
        if not story.get("source_session_id"):
            return None
        with self._connect() as connection:
            row = connection.execute(
                f"SELECT {TOPIC_SNAPSHOT} AS selected_topic FROM interview_sessions AS session "
                "WHERE session.user_id = %s AND session.id::text = %s",
                (user_id, str(story["source_session_id"])),
            ).fetchone()
        return valid_topic(row["selected_topic"], story["chapter_id"]) if row else None

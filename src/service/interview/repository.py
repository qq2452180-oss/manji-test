"""读写访谈暂停快照；沿用现有 interview_sessions 表。"""

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


class InterviewSessionRepository:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self):
        if not self._database_url:
            raise psycopg.OperationalError("MANJILU_DATABASE_URL is not configured")
        return psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=5)

    def create(self, user_id: int, resume_mode: str | None = None) -> dict:
        with self._connect() as connection:
            return connection.execute(
                "INSERT INTO interview_sessions (user_id, resume_mode) VALUES (%s, %s) RETURNING *",
                (user_id, resume_mode),
            ).fetchone()

    def get(self, user_id: int, session_id: int) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "SELECT * FROM interview_sessions WHERE id = %s AND user_id = %s",
                (session_id, user_id),
            ).fetchone()

    def has_user_input(self, user_id: int) -> bool:
        """仅用已保存的用户文字或照片识别聊过的用户，忽略纯开场会话。"""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT EXISTS ("
                "SELECT 1 FROM interview_sessions AS session "
                "CROSS JOIN LATERAL jsonb_array_elements(session.context) AS entry(message) "
                "WHERE session.user_id = %s AND message->>'type' = 'human' AND ("
                "(jsonb_typeof(message#>'{data,content}') = 'string' "
                "AND message#>>'{data,content}' ~ '[^[:space:]]') OR "
                "(jsonb_typeof(message#>'{data,additional_kwargs,media_ids}') = 'array' "
                "AND message#>'{data,additional_kwargs,media_ids}' <> '[]'::jsonb)"
                ")) AS has_user_input",
                (user_id,),
            ).fetchone()
        return row["has_user_input"]

    def has_opening(self, user_id: int) -> bool:
        """已有保存的非空助手开场即视为使用过，尚未回答或成稿也不重复介绍。"""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT EXISTS ("
                "SELECT 1 FROM interview_sessions AS session "
                "CROSS JOIN LATERAL jsonb_array_elements(session.context) AS entry(message) "
                "WHERE session.user_id = %s AND message->>'type' = 'ai' "
                "AND jsonb_typeof(message#>'{data,content}') = 'string' "
                "AND message#>>'{data,content}' ~ '[^[:space:]]'"
                ") AS has_opening", (user_id,),
            ).fetchone()
        return row["has_opening"]

    def latest_unfinished(self, user_id: int) -> dict | None:
        """按会话自己的结果判断进度，补充完成后不会误判成缺少故事。"""
        with self._connect() as connection:
            return connection.execute(
                "SELECT session.id, session.update_time, session.context, session.resume_mode, "
                "session.finish_time IS NOT NULL AS needs_processing "
                "FROM interview_sessions AS session LEFT JOIN story_revisions AS revision "
                "ON revision.source_session_id = session.id::text AND revision.user_id = session.user_id "
                "LEFT JOIN LATERAL (SELECT id, chapter_id, profile_processed, life_event_processed, summary FROM story "
                "WHERE user_id = session.user_id AND source_session_id = session.id::text "
                "ORDER BY id DESC LIMIT 1) AS latest_story ON TRUE "
                "WHERE session.user_id = %s AND session.context <> '[]'::jsonb AND ("
                "session.finish_time IS NULL OR CASE WHEN revision.id IS NOT NULL THEN revision.status <> 'completed' "
                "ELSE latest_story.id IS NULL OR (latest_story.chapter_id IS NULL AND NOT COALESCE(("
                "SELECT entry.message #>> '{data,additional_kwargs,interview_context,interview_scope}' "
                "FROM jsonb_array_elements(session.context) WITH ORDINALITY AS entry(message, position) "
                "WHERE entry.message->>'type' = 'ai' ORDER BY entry.position LIMIT 1) = 'global', FALSE)) "
                "OR NOT latest_story.profile_processed "
                "OR NOT latest_story.life_event_processed OR latest_story.summary IS NULL "
                "OR latest_story.summary !~ '[^[:space:]]' END "
                ") ORDER BY session.update_time DESC, session.id DESC LIMIT 1", (user_id,),
            ).fetchone()

    def update_mode(self, user_id: int, session_id: int, resume_mode: str) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "UPDATE interview_sessions SET resume_mode = %s "
                "WHERE id = %s AND user_id = %s AND finish_time IS NULL RETURNING *",
                (resume_mode, session_id, user_id),
            ).fetchone()

    def save(
        self, user_id: int, session_id: int, context: list,
        finished: bool = False,
    ) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "UPDATE interview_sessions SET context = %s, "
                "update_time = CURRENT_TIMESTAMP, "
                "finish_time = CASE WHEN %s THEN COALESCE(finish_time, CURRENT_TIMESTAMP) "
                "ELSE finish_time END WHERE id = %s AND user_id = %s RETURNING *",
                (Jsonb(context), finished, session_id, user_id),
            ).fetchone()

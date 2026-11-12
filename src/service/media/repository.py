"""media 表的五字段读写，图片内容保存在磁盘。"""

import psycopg
from psycopg.rows import dict_row


class MediaRepository:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self):
        if not self._database_url:
            raise psycopg.OperationalError("MANJILU_DATABASE_URL is not configured")
        return psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=5)

    def create(self, user_id: int, session_id: str, file_path: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "INSERT INTO media (user_id, session_id, file_path) VALUES (%s, %s, %s) "
                "RETURNING id",
                (user_id, session_id, file_path),
            ).fetchone()
        return row["id"]

    def get(self, user_id: int, session_id: str, media_id: int) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "SELECT id, user_id, session_id, file_path, create_time FROM media "
                "WHERE id = %s AND user_id = %s AND session_id = %s",
                (media_id, user_id, session_id),
            ).fetchone()

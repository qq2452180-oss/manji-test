"""新 users 表的读写；连接退出时提交或回滚，不在启动时建表。"""

import psycopg
from psycopg.rows import dict_row


class AuthRepository:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self):
        if not self._database_url:
            raise psycopg.OperationalError("MANJILU_DATABASE_URL is not configured")
        return psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=5)

    def create_user(self, username: str, password_hash: str) -> dict:
        with self._connect() as connection:
            return connection.execute(
                "INSERT INTO users (username, password) VALUES (%s, %s) "
                "RETURNING id, username, create_time",
                (username, password_hash),
            ).fetchone()

    def find_by_username(self, username: str) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "SELECT id, username, password FROM users WHERE username = %s AND NOT is_guest",
                (username,),
            ).fetchone()

    def create_guest(self, username: str, password_hash: str, token_hash: str) -> dict:
        with self._connect() as connection:
            return connection.execute(
                "INSERT INTO users (username, password, token, is_guest) "
                "VALUES (%s, %s, %s, TRUE) "
                "RETURNING id, username, create_time, is_guest",
                (username, password_hash, token_hash),
            ).fetchone()

    def upgrade_guest(self, token_hash: str, username: str, password_hash: str) -> dict | None:
        with self._connect() as connection:
            # 条件更新锁定同一用户行，并重新核验凭据与游客身份；保留 ID 和当前 token。
            return connection.execute(
                "UPDATE users SET username = %s, password = %s, is_guest = FALSE "
                "WHERE token = %s AND is_guest "
                "RETURNING id, username, create_time",
                (username, password_hash, token_hash),
            ).fetchone()

    def update_token(self, user_id: int, token_hash: str) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "UPDATE users SET token = %s WHERE id = %s "
                "RETURNING id, username, create_time",
                (token_hash, user_id),
            ).fetchone()

    def find_user_id_by_token(self, token_hash: str) -> int | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id FROM users WHERE token = %s", (token_hash,),
            ).fetchone()
        return row["id"] if row else None

    def find_user_by_token(self, token_hash: str) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "SELECT id, is_guest FROM users WHERE token = %s", (token_hash,),
            ).fetchone()

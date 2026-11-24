"""新 users 表的读写；连接退出时提交或回滚，不在启动时建表。"""

import psycopg
from psycopg.rows import dict_row


class AuthRepository:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self):
        if not self._database_url:
            raise psycopg.OperationalError("DATABASE_URL is not configured")
        return psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=5)

    def create_user(self, username: str, password_hash: str, token_hash: str | None = None) -> dict:
        with self._connect() as connection:
            return connection.execute(
                "INSERT INTO users (username, password, token) VALUES (%s, %s, %s) "
                "RETURNING id, username, create_time",
                (username, password_hash, token_hash),
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

    def upgrade_guest(
        self, token_hash: str, username: str, password_hash: str, new_token_hash: str | None = None,
    ) -> dict | None:
        with self._connect() as connection:
            # 旧 Bearer 客户端保留原凭证，浏览器升级时在同一事务内换发 cookie。
            return connection.execute(
                "UPDATE users SET username = %s, password = %s, is_guest = FALSE, token = COALESCE(%s, token) "
                "WHERE token = %s AND is_guest "
                "RETURNING id, username, create_time",
                (username, password_hash, new_token_hash, token_hash),
            ).fetchone()

    def update_token(self, user_id: int, token_hash: str) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "UPDATE users SET token = %s WHERE id = %s "
                "RETURNING id, username, create_time",
                (token_hash, user_id),
            ).fetchone()

    def find_user_id_by_token(self, token_hash: str) -> int | None:
        row = self.find_user_by_token(token_hash)
        return row["id"] if row else None

    def find_user_by_token(self, token_hash: str) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "SELECT id, is_guest FROM users WHERE token = %s "
                "AND (is_guest OR token_expires_at > statement_timestamp())", (token_hash,),
            ).fetchone()

    def revoke_token(self, token_hash: str) -> None:
        with self._connect() as connection:
            connection.execute("UPDATE users SET token = NULL WHERE token = %s", (token_hash,))

    def exchange_member_token(self, old_hash: str, new_hash: str) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "UPDATE users SET token = %s WHERE token = %s AND NOT is_guest "
                "AND token_expires_at > statement_timestamp() RETURNING id, username, create_time",
                (new_hash, old_hash),
            ).fetchone()

    def login_with_verified_phone(self, phone: str, username: str, password_hash: str, token_hash: str) -> dict:
        """手机号已完成校验；已有账号更新登录凭证，首次登录创建账号。"""
        with self._connect() as connection:
            return connection.execute("""
                INSERT INTO users (phone_e164, username, password, token) VALUES (%s, %s, %s, %s)
                ON CONFLICT (phone_e164) DO UPDATE SET token = EXCLUDED.token
                RETURNING id, username, create_time
                """, (phone, username, password_hash, token_hash)).fetchone()

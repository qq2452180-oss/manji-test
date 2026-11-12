"""用户画像在 PostgreSQL 中的查询与更新。"""

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


class ProfileRepository:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self):
        if not self._database_url:
            raise psycopg.OperationalError("MANJILU_DATABASE_URL is not configured")
        return psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=5)

    def get_profile(self, user_id: int) -> dict | None:
        """返回 JSONB 对应的 Python 字典；没有画像记录时返回 None。"""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT profile_data FROM user_profiles WHERE user_id = %s", (user_id,),
            ).fetchone()
        return row["profile_data"] if row is not None else None

    def save_profile(
        self, user_id: int, profile_data: dict, *, expected_profile: dict,
        story_id: int | None = None, revision_id: int | None = None,
    ) -> dict:
        """校验画像版本后保存；指定故事时一并记录处理完成，重复保存复用当前画像。"""
        with self._connect() as connection:
            if revision_id is not None:
                if story_id is None:
                    raise ValueError("补充处理缺少故事编号")
                # Follow the same story -> revision lock order as applying a draft.
                owned_story = connection.execute(
                    "SELECT id FROM story WHERE id = %s AND user_id = %s FOR UPDATE",
                    (story_id, user_id),
                ).fetchone()
                if owned_story is None:
                    raise ValueError("未找到该用户的故事")
                story = connection.execute(
                    "SELECT profile_processed, applied_version, status FROM story_revisions "
                    "WHERE id = %s AND user_id = %s AND story_id = %s FOR UPDATE",
                    (revision_id, user_id, story_id),
                ).fetchone()
                if story is None or story["applied_version"] is None or story["status"] not in {"applied", "completed"}:
                    raise ValueError("未找到已保存的故事补充")
                if story["profile_processed"]:
                    current = connection.execute(
                        "SELECT profile_data FROM user_profiles WHERE user_id = %s", (user_id,),
                    ).fetchone()
                    return current["profile_data"] if current is not None else {}
            elif story_id is not None:
                story = connection.execute(
                    "SELECT profile_processed FROM story "
                    "WHERE id = %s AND user_id = %s FOR UPDATE",
                    (story_id, user_id),
                ).fetchone()
                if story is None:
                    raise ValueError("未找到该用户的故事")
                if story["profile_processed"]:
                    current = connection.execute(
                        "SELECT profile_data FROM user_profiles WHERE user_id = %s", (user_id,),
                    ).fetchone()
                    return current["profile_data"] if current is not None else {}

            if expected_profile:
                row = connection.execute(
                    "UPDATE user_profiles SET profile_data = %s, updated_at = CURRENT_TIMESTAMP "
                    "WHERE user_id = %s AND profile_data = %s RETURNING profile_data",
                    (Jsonb(profile_data), user_id, Jsonb(expected_profile)),
                ).fetchone()
            else:
                row = connection.execute(
                    "INSERT INTO user_profiles (user_id, profile_data) VALUES (%s, %s) "
                    "ON CONFLICT (user_id) DO UPDATE "
                    "SET profile_data = EXCLUDED.profile_data, updated_at = CURRENT_TIMESTAMP "
                    "WHERE user_profiles.profile_data = '{}'::jsonb RETURNING profile_data",
                    (user_id, Jsonb(profile_data)),
                ).fetchone()

            if row is None:
                raise ValueError("画像已变化，请重新提取后再保存")

            if revision_id is not None:
                connection.execute(
                    "UPDATE story_revisions SET profile_processed = TRUE, update_time = CURRENT_TIMESTAMP "
                    "WHERE id = %s AND user_id = %s AND story_id = %s",
                    (revision_id, user_id, story_id),
                )
            elif story_id is not None:
                connection.execute(
                    "UPDATE story SET profile_processed = TRUE WHERE id = %s AND user_id = %s",
                    (story_id, user_id),
                )

        return row["profile_data"]

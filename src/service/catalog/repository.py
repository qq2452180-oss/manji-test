"""读取启用的章节与话题，供目录展示和访谈选题使用。"""

import psycopg
from psycopg.rows import dict_row

from .occupation_topics import parse_occupation_topics
from .templates import ensure_volumes


class CatalogSelectionLocked(ValueError):
    """主人公资料已确认，拒绝更换年代或职业。"""


class CatalogRepository:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self):
        if not self._database_url:
            raise psycopg.OperationalError("DATABASE_URL is not configured")
        return psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=5)

    def list_catalog(self) -> list[dict]:
        with self._connect() as connection:
            return self._chapters(connection, None)

    def member_catalog(self, user_id: int, decade: int | None = None, occupation: str | None = None) -> dict:
        with self._connect() as connection:
            user = connection.execute(
                "SELECT birth_decade, occupation, occupation_topic_keys FROM users WHERE id = %s"
                + (" FOR UPDATE" if decade is not None else ""), (user_id,),
            ).fetchone()
            if decade is not None:
                if user["birth_decade"] is not None:
                    if (user["birth_decade"], user["occupation"]) != (decade, occupation):
                        raise CatalogSelectionLocked("出生年代和职业已确认，不能修改模板。")
                else:
                    # 锁住账号后再初始化目录，首次并发提交也只能确定一套选择。
                    ensure_volumes(connection, decade)
                    user = connection.execute(
                        "UPDATE users SET birth_decade = %s, occupation = %s WHERE id = %s "
                        "RETURNING birth_decade, occupation, occupation_topic_keys",
                        (decade, occupation, user_id),
                    ).fetchone()
            return self._member_catalog(connection, user_id, user)

    def append_occupation_topics(
        self, user_id: int, source: str, *,
        birth_decade: int | None = None, occupation: str | None = None,
    ) -> dict:
        with self._connect() as connection:
            user = connection.execute(
                "SELECT birth_decade, occupation, occupation_topic_keys FROM users WHERE id = %s FOR UPDATE", (user_id,),
            ).fetchone()
            if user is None or user["birth_decade"] is None:
                raise ValueError("请先选择出生年代")
            decade = user["birth_decade"]
            catalog = self._member_catalog(connection, user_id, user)
            key = f"{birth_decade}:{occupation}"
            if occupation is not None and (
                (decade, user["occupation"]) != (birth_decade, occupation) or key in user["occupation_topic_keys"]
            ):
                return catalog
            chapters = catalog["chapters"]
            additions = parse_occupation_topics(source, chapters)
            orders = {chapter["id"]: max((topic["sort_order"] for topic in chapter["topics"]), default=0)
                      for chapter in chapters}
            with connection.cursor() as cursor:
                for topic in additions:
                    orders[topic["chapter_id"]] += 1
                    cursor.execute(
                        "INSERT INTO topic (chapter_id, section_title, title, description, sort_order, owner_user_id) "
                        "VALUES (%s, %s, %s, %s, %s, %s)",
                        (topic["chapter_id"], topic["section_title"], topic["title"], topic["description"],
                         orders[topic["chapter_id"]], user_id),
                    )
            if occupation is not None:
                connection.execute(
                    "UPDATE users SET occupation_topic_keys = array_append(occupation_topic_keys, %s) WHERE id = %s",
                    (key, user_id),
                )
                user["occupation_topic_keys"].append(key)
            return self._member_catalog(connection, user_id, user)

    def _member_catalog(self, connection, user_id: int, user: dict) -> dict:
        decade = user["birth_decade"]
        catalog = {"birth_decade": decade, "occupation": user["occupation"],
                   "chapters": self._chapters(connection, decade, user_id) if decade else []}
        if user["occupation"]:
            key = f"{decade}:{user['occupation']}"
            catalog["occupation_status"] = "completed" if key in user["occupation_topic_keys"] else "idle"
        return catalog

    @staticmethod
    def _chapters(connection, decade: int | None, user_id: int | None = None) -> list[dict]:
        rows = connection.execute(
            "SELECT chapter.id AS chapter_id, chapter.title AS chapter_title, "
            "chapter.volume_title, topic.section_title, "
            "chapter.sort_order AS chapter_sort_order, topic.id AS topic_id, "
            "topic.title AS topic_title, topic.description AS topic_description, "
            "topic.sort_order AS topic_sort_order "
            "FROM chapter LEFT JOIN topic ON topic.chapter_id = chapter.id "
            "AND topic.is_enabled = TRUE AND (topic.owner_user_id IS NULL OR topic.owner_user_id = %s) "
            "WHERE chapter.is_enabled = TRUE AND chapter.birth_decade IS NOT DISTINCT FROM %s "
            "ORDER BY chapter.sort_order, chapter.id, topic.sort_order, topic.id", (user_id, decade),
        ).fetchall()
        chapters = {}
        for row in rows:
            chapter = chapters.setdefault(row["chapter_id"], {
                "id": row["chapter_id"], "title": row["chapter_title"],
                "sort_order": row["chapter_sort_order"], "topics": [],
                **({"volume_title": row["volume_title"]} if decade else {}),
            })
            if row["topic_id"] is not None:
                chapter["topics"].append({
                    "id": row["topic_id"], "chapter_id": row["chapter_id"],
                    "title": row["topic_title"], "description": row["topic_description"],
                    "sort_order": row["topic_sort_order"],
                    **({"section_title": row["section_title"]} if decade else {}),
                })
        return list(chapters.values())

    def get_enabled_topic(self, topic_id: int, *, user_id: int | None = None) -> dict | None:
        scope = (" AND chapter.birth_decade = "
                 "(SELECT birth_decade FROM users WHERE id = %s) "
                 "AND (topic.owner_user_id IS NULL OR topic.owner_user_id = %s)") if user_id is not None else ""
        with self._connect() as connection:
            return connection.execute(
                "SELECT topic.id, topic.chapter_id, chapter.title AS chapter_title, "
                "topic.title, topic.description "
                "FROM topic JOIN chapter ON chapter.id = topic.chapter_id "
                "WHERE topic.id = %s AND topic.is_enabled = TRUE AND chapter.is_enabled = TRUE" + scope,
                (topic_id, user_id, user_id) if user_id is not None else (topic_id,),
            ).fetchone()

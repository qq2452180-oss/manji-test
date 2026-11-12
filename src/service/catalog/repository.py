"""读取启用的章节与话题，供目录展示和访谈选题使用。"""

import psycopg
from psycopg.rows import dict_row


class CatalogRepository:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self):
        if not self._database_url:
            raise psycopg.OperationalError("MANJILU_DATABASE_URL is not configured")
        return psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=5)

    def list_catalog(self) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT chapter.id AS chapter_id, chapter.title AS chapter_title, "
                "chapter.sort_order AS chapter_sort_order, topic.id AS topic_id, "
                "topic.title AS topic_title, topic.description AS topic_description, "
                "topic.sort_order AS topic_sort_order "
                "FROM chapter LEFT JOIN topic ON topic.chapter_id = chapter.id "
                "AND topic.is_enabled = TRUE "
                "WHERE chapter.is_enabled = TRUE "
                "ORDER BY chapter.sort_order, chapter.id, topic.sort_order, topic.id"
            ).fetchall()
        chapters = {}
        for row in rows:
            chapter = chapters.setdefault(row["chapter_id"], {
                "id": row["chapter_id"], "title": row["chapter_title"],
                "sort_order": row["chapter_sort_order"], "topics": [],
            })
            if row["topic_id"] is not None:
                chapter["topics"].append({
                    "id": row["topic_id"], "chapter_id": row["chapter_id"],
                    "title": row["topic_title"], "description": row["topic_description"],
                    "sort_order": row["topic_sort_order"],
                })
        return list(chapters.values())

    def get_enabled_topic(self, topic_id: int) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "SELECT topic.id, topic.chapter_id, chapter.title AS chapter_title, "
                "topic.title, topic.description "
                "FROM topic JOIN chapter ON chapter.id = topic.chapter_id "
                "WHERE topic.id = %s AND topic.is_enabled = TRUE AND chapter.is_enabled = TRUE",
                (topic_id,),
            ).fetchone()

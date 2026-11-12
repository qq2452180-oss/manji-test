"""保存故事及访谈所属章节；连接退出时提交事务。"""

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .layout import split_story_paragraphs
from .revisions import StoryRevisionRepository, StoryVersionConflict
from .scope import readable_story_sql


class StoryRepository(StoryRevisionRepository):
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self):
        if not self._database_url:
            raise psycopg.OperationalError("MANJILU_DATABASE_URL is not configured")
        return psycopg.connect(self._database_url, row_factory=dict_row, connect_timeout=5)

    @staticmethod
    def _validate_photo_layout(body: str, layout: list[dict]) -> tuple[list[dict], set[int]]:
        if not isinstance(layout, list):
            raise ValueError("故事配图格式无效")
        media_ids = set()
        saved_layout = []
        paragraph_count = len(split_story_paragraphs(body))
        for item in layout:
            if not isinstance(item, dict):
                raise ValueError("故事配图格式无效")
            media_id, position = item.get("media_id"), item.get("after_paragraph")
            if type(media_id) is not int or media_id <= 0 or media_id in media_ids:
                raise ValueError("故事配图编号无效或重复")
            if position is not None and (
                type(position) is not int or not 1 <= position <= paragraph_count
            ):
                raise ValueError("故事配图段落无效")
            media_ids.add(media_id)
            saved_layout.append({"media_id": media_id, "after_paragraph": position})
        return saved_layout, media_ids

    def create(
        self, user_id: int, title: str, body: str, *,
        chapter_id: int | None,
        source_session_id: str | None = None, photo_layout: list[dict] | None = None,
    ) -> int:
        if chapter_id is not None and (type(chapter_id) is not int or not 0 < chapter_id <= 2**63 - 1):
            raise ValueError("故事缺少有效的访谈章节")
        if source_session_id is not None and (
            not isinstance(source_session_id, str) or not source_session_id.strip()
        ):
            raise ValueError("故事来源会话无效")
        saved_layout, media_ids = self._validate_photo_layout(
            body, [] if photo_layout is None else photo_layout,
        )
        if media_ids and source_session_id is None:
            raise ValueError("故事配图缺少来源会话")
        with self._connect() as connection:
            if chapter_id is None:
                source = connection.execute(
                    "SELECT context FROM interview_sessions WHERE id::text = %s AND user_id = %s",
                    (source_session_id, user_id),
                ).fetchone()
                opening = next((message for message in source['context'] if message.get('type') == 'ai'), {}) if source else {}
                scope = opening.get('data', {}).get('additional_kwargs', {}).get('interview_context', {}).get('interview_scope')
                if scope != 'global':
                    raise ValueError("故事缺少有效的访谈章节")
            if media_ids:
                owned_media = connection.execute(
                    "SELECT id FROM media WHERE id = ANY(%s) "
                    "AND user_id = %s AND session_id = %s FOR SHARE",
                    (sorted(media_ids), user_id, source_session_id),
                ).fetchall()
                if {row["id"] for row in owned_media} != media_ids:
                    raise ValueError("故事配图不属于当前用户和访谈")
            if source_session_id is not None:
                # 进程内的会话锁无法覆盖多个服务进程；只在落库阶段串行同一来源。
                connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                    (f"manji:story:{user_id}:{source_session_id}",),
                )
                existing = connection.execute(
                    "SELECT id FROM story WHERE user_id = %s AND source_session_id = %s "
                    "ORDER BY id DESC LIMIT 1", (user_id, source_session_id),
                ).fetchone()
                if existing is not None:
                    return existing["id"]
            row = connection.execute(
                "INSERT INTO story (user_id, title, body, chapter_id, source_session_id, photo_layout) "
                "VALUES (%s, %s, %s, %s, %s, %s) "
                "RETURNING id",
                (user_id, title, body, chapter_id, source_session_id, Jsonb(saved_layout)),
            ).fetchone()
        return row["id"]

    def get_by_session(self, user_id: int, source_session_id: str) -> dict | None:
        """恢复本场故事；有补充记录时沿用原有的原稿恢复逻辑。"""
        with self._connect() as connection:
            revision = connection.execute(
                "SELECT * FROM story_revisions WHERE user_id = %s AND source_session_id = %s",
                (user_id, source_session_id),
            ).fetchone()
            if revision is not None:
                return self.revision_result(revision) if revision['applied_version'] is not None else None
            story = connection.execute(
                "SELECT id AS story_id, title, body, chapter_id, summary, "
                "source_session_id, photo_layout, profile_processed, life_event_processed FROM story "
                "WHERE user_id = %s AND source_session_id = %s ORDER BY id DESC LIMIT 1",
                (user_id, source_session_id),
            ).fetchone()
            if story is not None:
                original = connection.execute(
                    'SELECT original_story FROM story_revisions WHERE user_id = %s AND story_id = %s ORDER BY id LIMIT 1',
                    (user_id, story['story_id']),
                ).fetchone()
                if original is not None:
                    snapshot = original['original_story']
                    story = {key: snapshot[key] for key in story}
            return story

    def get_postprocessing_status(self, user_id: int, story_id: int, *, revision_id=None) -> dict:
        """补充处理进度以本场 revision 为准，不重置原故事标记。"""
        with self._connect() as connection:
            if revision_id is not None:
                row = connection.execute(
                    "SELECT profile_processed, life_event_processed FROM story_revisions "
                    "WHERE id = %s AND story_id = %s AND user_id = %s AND status IN ('applied','completed')",
                    (revision_id, story_id, user_id),
                ).fetchone()
            else:
                row = connection.execute(
                    "SELECT profile_processed, life_event_processed FROM story WHERE id = %s AND user_id = %s",
                    (story_id, user_id),
                ).fetchone()
        if row is None:
            raise ValueError("未找到该用户的故事")
        return row

    def get_opening_history(self, user_id: int) -> dict:
        """在同一查询快照中判断历史，并读取最近一篇已有章节的故事。"""
        with self._connect() as connection:
            return connection.execute(
                "SELECT EXISTS (SELECT 1 FROM story WHERE user_id = %s) AS has_story, "
                "(SELECT jsonb_build_object('story_id', id, 'title', title, 'summary', summary, "
                "'life_event_id', life_event_id) "
                f"FROM story WHERE user_id = %s AND {readable_story_sql()} "
                "ORDER BY create_time DESC, id DESC LIMIT 1) AS previous_story",
                (user_id, user_id),
            ).fetchone()

    def get_for_summary(self, user_id: int, story_id: int, *, revision_id=None) -> dict | None:
        with self._connect() as connection:
            if revision_id is not None:
                return connection.execute(
                    "SELECT title, body, summary FROM story_revisions WHERE id = %s AND story_id = %s "
                    "AND user_id = %s AND status IN ('applied','completed')",
                    (revision_id, story_id, user_id),
                ).fetchone()
            return connection.execute(
                "SELECT title, body, summary FROM story WHERE id = %s AND user_id = %s",
                (story_id, user_id),
            ).fetchone()

    def set_summary(self, user_id: int, story_id: int, summary: str, *, revision_id=None) -> str:
        if not isinstance(summary, str) or not summary.strip() or len(summary.strip()) > 600:
            raise ValueError("故事摘要必须是 600 字以内的非空文字")
        with self._connect() as connection:
            if revision_id is not None:
                connection.execute('SELECT id FROM story WHERE id = %s AND user_id = %s FOR UPDATE', (story_id, user_id))
                row = connection.execute(
                    "UPDATE story_revisions SET summary = COALESCE(NULLIF(BTRIM(summary), ''), %s), "
                    "status = 'completed', update_time = CURRENT_TIMESTAMP "
                    "WHERE id = %s AND user_id = %s AND story_id = %s AND status IN ('applied','completed') "
                    'AND profile_processed AND life_event_processed RETURNING summary, applied_version',
                    (summary.strip(), revision_id, user_id, story_id),
                ).fetchone()
                if row is None:
                    raise ValueError('补充记忆处理尚未完成')
                connection.execute(
                    'UPDATE story SET summary = %s WHERE id = %s AND user_id = %s AND version = %s',
                    (row['summary'], story_id, user_id, row['applied_version']),
                )
            else:
                row = connection.execute(
                    "UPDATE story SET summary = CASE "
                    "WHEN summary IS NULL OR BTRIM(summary) = '' THEN %s ELSE summary END "
                    "WHERE id = %s AND user_id = %s RETURNING summary",
                    (summary.strip(), story_id, user_id),
                ).fetchone()
                if row is None:
                    raise ValueError("未找到该用户的故事")
        return row['summary']

    def list_recent(self, user_id: int) -> list[dict]:
        with self._connect() as connection:
            return connection.execute(
                "SELECT id AS story_id, title, create_time FROM story "
                f"WHERE user_id = %s AND {readable_story_sql()} "
                "ORDER BY create_time DESC, id DESC LIMIT 5",
                (user_id,),
            ).fetchall()

    def list_recent_for_planning(self, user_id: int, limit: int = 5) -> list[dict]:
        """兼容历史规划的近期故事查询。"""
        return self._list_story_memories(user_id, limit=limit)

    def list_for_interview(self, user_id: int) -> list[dict]:
        """读取本人全部可读故事的标题、摘要及关联信息，不加载正文。"""
        return self._list_story_memories(user_id)

    def _list_story_memories(self, user_id: int, *, limit: int | None = None) -> list[dict]:
        with self._connect() as connection:
            return connection.execute(
                "SELECT story.id AS story_id, story.title, story.summary, "
                "story.chapter_id, chapter.title AS chapter_title, "
                "event.id AS life_event_id, event.life_stage, story.create_time AS created_at "
                "FROM story LEFT JOIN life_events AS event "
                "ON event.id = story.life_event_id AND event.user_id = story.user_id "
                "LEFT JOIN chapter ON chapter.id = story.chapter_id "
                f"WHERE story.user_id = %s AND {readable_story_sql()} "
                "ORDER BY story.create_time DESC, story.id DESC"
                + (" LIMIT %s" if limit is not None else ""),
                (user_id, limit) if limit is not None else (user_id,),
            ).fetchall()

    def count_by_life_event(self, user_id: int) -> dict[int, int]:
        """统计本人各经历下已有章节的故事数，不受近期故事窗口限制。"""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT event.id AS life_event_id, COUNT(*) AS story_count "
                "FROM story JOIN life_events AS event "
                "ON event.id = story.life_event_id AND event.user_id = story.user_id "
                f"WHERE story.user_id = %s AND {readable_story_sql()} "
                "GROUP BY event.id",
                (user_id,),
            ).fetchall()
        return {row["life_event_id"]: row["story_count"] for row in rows}

    def get_completed(self, user_id: int, story_id: int) -> dict | None:
        with self._connect() as connection:
            return connection.execute(
                "SELECT id AS story_id, title, body, create_time, chapter_id, "
                "source_session_id, photo_layout, version, updated_time FROM story "
                f"WHERE id = %s AND user_id = %s AND {readable_story_sql()}",
                (story_id, user_id),
            ).fetchone()

    def update_completed(
        self, user_id: int, story_id: int, title: str, body: str,
        photo_layout: list[dict], *, expected_version: int | None = None,
    ) -> dict | None:
        if not isinstance(title, str) or not title.strip():
            raise ValueError("故事标题不能为空")
        if not isinstance(body, str) or not body.strip():
            raise ValueError("故事正文不能为空")
        title, body = title.strip(), body.strip()
        saved_layout, media_ids = self._validate_photo_layout(body, photo_layout)
        with self._connect() as connection:
            current = connection.execute(
                "SELECT photo_layout, version FROM story "
                f"WHERE id = %s AND user_id = %s AND {readable_story_sql()} FOR UPDATE",
                (story_id, user_id),
            ).fetchone()
            if current is None:
                return None
            if expected_version is not None and current["version"] != expected_version:
                raise StoryVersionConflict("故事已被修改，请重新读取后再保存")
            if media_ids != {item["media_id"] for item in current["photo_layout"]}:
                raise ValueError("只能调整故事现有照片的位置")
            return connection.execute(
                "UPDATE story SET title = %s, body = %s, photo_layout = %s, version = version + 1, updated_time = CURRENT_TIMESTAMP "
                "WHERE id = %s AND user_id = %s "
                "RETURNING id AS story_id, title, body, create_time, chapter_id, "
                "source_session_id, photo_layout, version, updated_time",
                (title, body, Jsonb(saved_layout), story_id, user_id),
            ).fetchone()

    def list_user_chapters(self, user_id: int) -> list[dict]:
        with self._connect() as connection:
            return connection.execute(
                "SELECT chapter.id AS chapter_id, chapter.title, COUNT(*) AS story_count, "
                "MAX(story.create_time) AS last_story_time "
                "FROM chapter JOIN story ON story.chapter_id = chapter.id "
                "WHERE story.user_id = %s "
                "GROUP BY chapter.id, chapter.title, chapter.sort_order "
                "ORDER BY chapter.sort_order, chapter.id",
                (user_id,),
            ).fetchall()

    def get_chapter(self, user_id: int, chapter_id: int) -> dict | None:
        with self._connect() as connection:
            chapter = connection.execute(
                "SELECT id AS chapter_id, title FROM chapter WHERE id = %s",
                (chapter_id,),
            ).fetchone()
            if chapter is None:
                return None
            stories = connection.execute(
                "SELECT id AS story_id, title, body, create_time, "
                "source_session_id, photo_layout, version, updated_time FROM story "
                "WHERE user_id = %s AND chapter_id = %s ORDER BY create_time, id",
                (user_id, chapter_id),
            ).fetchall()
        return {"chapter": chapter, "stories": stories}

    def restore_chapter(self, user_id: int, story_id: int, chapter_id: int) -> int:
        """仅为旧流程留下的缺章故事补齐访谈章节，已有归属保持不变。"""
        if type(chapter_id) is not int or not 0 < chapter_id <= 2**63 - 1:
            raise ValueError("故事缺少有效的访谈章节")
        with self._connect() as connection:
            row = connection.execute(
                "UPDATE story SET chapter_id = COALESCE(chapter_id, %s) "
                "WHERE id = %s AND user_id = %s RETURNING chapter_id",
                (chapter_id, story_id, user_id),
            ).fetchone()
            if row is None:
                raise ValueError("未找到该用户的故事")
        return row["chapter_id"]

"""访谈记忆与数据库话题读取，以及故事索引查询的用户隔离。"""

from copy import deepcopy
from datetime import datetime, timezone
import json
from types import SimpleNamespace
from unittest.mock import Mock

from langchain_core.messages import AIMessage
import psycopg
import pytest

from src.common.dialogue.message_ids import messages_to_context
from src.service.interview import InterviewMemoryService
from src.service.interview.memory_input import load_selected_topic
from src.service.interview.repository import InterviewSessionRepository
from src.service.catalog import CatalogError, CatalogService
from src.service.life_event import LifeEventRepository
from src.service.profile import ProfileRepository
from src.service.story import StoryRepository
from src.tests.test_life_event_repository import life_event_database  # noqa: F401


@pytest.fixture
def story_index_database(life_event_database):
    with psycopg.connect(life_event_database) as connection:
        connection.execute("INSERT INTO chapter (title, sort_order) VALUES ('青年', 1)")
    return life_event_database


@pytest.fixture
def materials():
    profiles = Mock(spec=ProfileRepository)
    events = Mock(spec=LifeEventRepository)
    stories = Mock(spec=StoryRepository)
    profiles.get_profile.return_value = {"education_career": {"main_occupation": "纺织工"}}
    events.get_life_events.return_value = [{
        "id": 8, "title": "进纺织厂", "summary": "刚进厂，还没有讲学做工的过程。",
        "life_stage": "青年", "time_text": "1981年", "status": "expandable",
    }]
    stories.get_opening_history.return_value = {
        "has_story": True,
        "previous_story": {
            "story_id": 7, "title": "初到车间", "summary": "师傅让我先在旁边看。", "life_event_id": 8,
        },
    }
    stories.list_for_interview.return_value = [{
        "story_id": 7, "title": "初到车间", "summary": None,
        "chapter_id": 1, "chapter_title": "青年",
        "life_event_id": None, "life_stage": None,
        "created_at": datetime(2026, 11, 1, 10, tzinfo=timezone.utc),
    }]
    return SimpleNamespace(
        service=InterviewMemoryService(profiles, events, stories),
        profiles=profiles, events=events, stories=stories,
    )


def test_memory_reads_same_user_without_modifying_saved_materials(materials):
    original_stories = deepcopy(materials.stories.list_for_interview.return_value)
    original_events = deepcopy(materials.events.get_life_events.return_value)

    result = materials.service.build(11)

    assert result["user_profile"] == materials.profiles.get_profile.return_value
    assert result["previous_story_id"] == 7
    assert result["life_event_context"]["events"] == original_events
    assert result["life_event_context"]["stories"] == [{
        **original_stories[0], "created_at": "2026-11-01T10:00:00+00:00",
    }]
    assert materials.stories.list_for_interview.return_value == original_stories
    assert materials.events.get_life_events.return_value == original_events
    assert set(result) == {"user_profile", "previous_story_id", "life_event_context"}
    assert json.loads(json.dumps(result, ensure_ascii=False)) == result
    materials.profiles.get_profile.assert_called_once_with(11)
    materials.events.get_life_events.assert_called_once_with(11)
    materials.stories.get_opening_history.assert_called_once_with(11)
    materials.stories.list_for_interview.assert_called_once_with(11)
    materials.stories.list_recent_for_planning.assert_not_called()
    materials.stories.count_by_life_event.assert_not_called()


def test_first_visit_keeps_empty_memories(materials):
    materials.profiles.get_profile.return_value = None
    materials.events.get_life_events.return_value = []
    materials.stories.get_opening_history.return_value = {"has_story": False, "previous_story": None}
    materials.stories.list_for_interview.return_value = []

    assert materials.service.build(11) == {
        "user_profile": {}, "previous_story_id": None,
        "life_event_context": {"events": [], "stories": []},
    }


def test_supplied_opening_history_is_reused_without_a_second_query(materials):
    history = materials.stories.get_opening_history.return_value
    materials.stories.get_opening_history.side_effect = AssertionError("不得再次选择上一故事")

    result = materials.service.build(11, history=history)

    assert result["previous_story_id"] == history["previous_story"]["story_id"]
    materials.stories.get_opening_history.assert_not_called()


def test_selected_topic_keeps_only_catalog_fields_without_questions_or_rules():
    catalog = Mock(spec=CatalogService)
    source = {
        "id": 13, "chapter_id": 2, "title": "住过的地方", "description": "小时候住处附近的景物。",
        "chapter_title": "早年生活与长大的地方",
        "prompt": "旧问题不带入", "followups": ["旧追问不带入"], "is_enabled": True,
    }
    catalog.get_enabled_topic.return_value = source
    topic = load_selected_topic(13, catalog=catalog)
    assert topic == {key: source[key] for key in ("id", "chapter_id", "chapter_title", "title", "description")}
    catalog.get_enabled_topic.assert_called_once_with(13)
    topic["description"] = "调用方的修改"
    assert source["description"] == "小时候住处附近的景物。"
    with pytest.raises(ValueError, match="请先选择"):
        load_selected_topic(None)
    with pytest.raises(ValueError, match="请先选择"):
        load_selected_topic(None, catalog=catalog)
    catalog.get_enabled_topic.assert_called_once()


@pytest.mark.parametrize("topic_id", ["", " ", "missing", "13", "MJ2-L1-01", 0, -1, True, 1.5, 2**63, [], {}])
def test_invalid_topic_is_rejected(topic_id):
    catalog = Mock(spec=CatalogService)
    with pytest.raises(ValueError):
        load_selected_topic(topic_id, catalog=catalog)
    catalog.get_enabled_topic.assert_not_called()


def test_unavailable_topic_is_rejected_and_configured_catalog_is_required():
    catalog = Mock(spec=CatalogService)
    catalog.get_enabled_topic.return_value = None
    with pytest.raises(ValueError, match="不存在或已停用"):
        load_selected_topic(13, catalog=catalog)
    with pytest.raises(CatalogError) as error:
        load_selected_topic(13)
    assert error.value.status_code == 503


def test_story_creation_saves_chapter_atomically(story_index_database):
    repository = StoryRepository(story_index_database)
    story_id = repository.create(1, "已有章节的新成稿", "用户的原始讲述。", chapter_id=1)
    with psycopg.connect(story_index_database) as connection:
        assert connection.execute(
            "SELECT title, body, chapter_id FROM story WHERE id = %s", (story_id,),
        ).fetchone() == ("已有章节的新成稿", "用户的原始讲述。", 1)
        before = connection.execute("SELECT COUNT(*) FROM story").fetchone()[0]
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        repository.create(1, "不应留下半成稿", "正文", chapter_id=999999)
    with psycopg.connect(story_index_database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM story").fetchone()[0] == before


def test_restore_chapter_fills_only_missing_owned_story_and_returns_actual_chapter(story_index_database):
    repository = StoryRepository(story_index_database)
    with psycopg.connect(story_index_database) as connection:
        alternate = connection.execute("INSERT INTO chapter (title) VALUES ('另一个章节') RETURNING id").fetchone()[0]
        original = connection.execute("SELECT title, body FROM story WHERE id = 1").fetchone()
    assert repository.restore_chapter(1, 1, 1) == 1
    assert repository.restore_chapter(1, 1, alternate) == 1
    with pytest.raises(ValueError):
        repository.restore_chapter(2, 1, alternate)
    with pytest.raises(ValueError):
        repository.restore_chapter(1, 999999, alternate)
    with psycopg.connect(story_index_database) as connection:
        assert connection.execute("SELECT title, body FROM story WHERE id = 1").fetchone() == original
        assert connection.execute("SELECT chapter_id FROM story WHERE id = 1").fetchone() == (1,)


def test_recent_stories_keep_unlinked_rows_and_filter_users_and_unplaced(story_index_database):
    with psycopg.connect(story_index_database) as connection:
        connection.execute("UPDATE story SET chapter_id = 1, create_time = '2026-11-01T10:00:00+00:00'")
        own_event = connection.execute(
            "INSERT INTO life_events (user_id, title, life_stage) VALUES (1, '北京打工', '青年') RETURNING id",
        ).fetchone()[0]
        other_event = connection.execute(
            "INSERT INTO life_events (user_id, title, life_stage) VALUES (2, '其他用户经历', '中年') RETURNING id",
        ).fetchone()[0]
        connection.execute("UPDATE story SET life_event_id = %s WHERE id = 1", (own_event,))
        wrong_link = connection.execute(
            "INSERT INTO story (user_id, title, body, chapter_id, life_event_id, create_time) "
            "VALUES (1, '关联不属于本人的经历', '正文', 1, %s, '2026-11-02T10:00:00+00:00') RETURNING id",
            (other_event,),
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO story (user_id, title, body, create_time) "
            "VALUES (1, '尚未归章', '正文', '2026-11-03T10:00:00+00:00')",
        )

    repository = StoryRepository(story_index_database)
    rows = repository.list_recent_for_planning(1)

    assert [row["story_id"] for row in rows] == [wrong_link, 2, 1]
    assert [(row["life_event_id"], row["life_stage"]) for row in rows] == [
        (None, None), (None, None), (own_event, "青年"),
    ]
    assert rows[0]["summary"] is None
    assert rows[0]["created_at"].tzinfo is not None
    assert repository.list_recent_for_planning(1, limit=1) == rows[:1]


def test_interview_stories_include_all_owned_readable_stories_and_preserve_missing_summaries(story_index_database):
    sessions = InterviewSessionRepository(story_index_database)
    session = sessions.create(1)
    sessions.save(1, session["id"], messages_to_context([
        AIMessage(id="1", content="开场", additional_kwargs={"interview_context": {"interview_scope": "global"}}),
    ]), finished=True)
    with psycopg.connect(story_index_database) as connection:
        connection.execute("UPDATE story SET chapter_id = 1, create_time = '2026-11-01T10:00:00+00:00'")
        foreign_event = connection.execute(
            "INSERT INTO life_events (user_id, title, life_stage) VALUES (2, '他人的经历', '中年') RETURNING id",
        ).fetchone()[0]
        connection.execute("UPDATE story SET life_event_id = %s WHERE id = 2", (foreign_event,))
        added = connection.execute(
            "INSERT INTO story (user_id, title, body, summary, chapter_id, create_time) "
            "SELECT 1, '历史故事 ' || item, '这段全文不应进入记忆库', "
            "CASE WHEN item = 1 THEN NULL WHEN item = 2 THEN '' ELSE '故事摘要 ' || item END, "
            "1, '2026-11-02T10:00:00+00:00' FROM generate_series(1, 6) AS item RETURNING id",
        ).fetchall()
        global_id = connection.execute(
            "INSERT INTO story (user_id, title, body, summary, source_session_id, create_time) "
            "VALUES (1, '全局讲述', '全局正文', '全局摘要', %s, '2026-11-03T10:00:00+00:00') RETURNING id",
            (str(session["id"]),),
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO story (user_id, title, body, create_time) "
            "VALUES (1, '旧的无章节记录', '旧正文', '2026-11-04T10:00:00+00:00')",
        )

    repository = StoryRepository(story_index_database)
    rows = repository.list_for_interview(1)

    assert [row["story_id"] for row in rows] == [global_id, *reversed([row[0] for row in added]), 2, 1]
    assert len(rows) == 9
    by_id = {row["story_id"]: row for row in rows}
    assert by_id[global_id]["chapter_id"] is None and by_id[global_id]["chapter_title"] is None
    assert by_id[global_id]["title"] == "全局讲述" and by_id[global_id]["summary"] == "全局摘要"
    assert all((row["chapter_id"], row["chapter_title"]) == (1, "青年") for row in rows[1:])
    assert by_id[added[0][0]]["summary"] is None
    assert by_id[added[1][0]]["summary"] == ""
    assert by_id[2]["life_event_id"] is None and by_id[2]["life_stage"] is None
    assert all("body" not in row for row in rows)
    assert all(row["created_at"].tzinfo is not None for row in rows)
    assert repository.list_for_interview(999) == []
    assert [row["story_id"] for row in repository.list_for_interview(2)] == [3]


def test_story_counts_use_all_completed_owned_event_stories(story_index_database):
    with psycopg.connect(story_index_database) as connection:
        first_event = connection.execute(
            "INSERT INTO life_events (user_id, title) VALUES (1, '北京打工') RETURNING id",
        ).fetchone()[0]
        second_event = connection.execute(
            "INSERT INTO life_events (user_id, title) VALUES (1, '乡下生活') RETURNING id",
        ).fetchone()[0]
        other_event = connection.execute(
            "INSERT INTO life_events (user_id, title) VALUES (2, '其他用户经历') RETURNING id",
        ).fetchone()[0]
        for user_id, event_id, count in (
            (1, first_event, 6), (1, second_event, 4), (2, other_event, 2),
        ):
            connection.execute(
                "INSERT INTO story (user_id, title, body, chapter_id, life_event_id) "
                "SELECT %s, '已归章故事 ' || item, '正文', 1, %s "
                "FROM generate_series(1, %s) AS item",
                (user_id, event_id, count),
            )
        connection.execute(
            "INSERT INTO story (user_id, title, body, chapter_id, life_event_id) VALUES "
            "(1, '未归章', '正文', NULL, %s), "
            "(1, '未关联索引', '正文', 1, NULL), "
            "(1, '误关联其他用户索引', '正文', 1, %s), "
            "(2, '其他用户误关联本人索引', '正文', 1, %s)",
            (first_event, other_event, first_event),
        )

    repository = StoryRepository(story_index_database)

    assert len(repository.list_recent_for_planning(1)) == 5
    assert repository.count_by_life_event(1) == {first_event: 6, second_event: 4}
    assert repository.count_by_life_event(2) == {other_event: 2}
    assert repository.count_by_life_event(999) == {}


def test_opening_history_keeps_the_latest_completed_story_event(story_index_database):
    with psycopg.connect(story_index_database) as connection:
        event_id = connection.execute(
            "INSERT INTO life_events (user_id, title) VALUES (1, '北京打工') RETURNING id",
        ).fetchone()[0]
        story_id = connection.execute(
            "INSERT INTO story (user_id, title, body, summary, chapter_id, life_event_id, create_time) "
            "VALUES (1, '初到车间', '正文', '师傅让我先在旁边看。', 1, %s, "
            "'2026-11-01T10:00:00+00:00') RETURNING id",
            (event_id,),
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO story (user_id, title, body, chapter_id, create_time) VALUES "
            "(1, '更新但未归章', '正文', NULL, '2026-11-02T10:00:00+00:00'), "
            "(2, '其他用户更新的故事', '正文', 1, '2026-11-03T10:00:00+00:00')",
        )

    repository = StoryRepository(story_index_database)

    assert repository.get_opening_history(1) == {
        "has_story": True,
        "previous_story": {
            "story_id": story_id, "title": "初到车间", "summary": "师傅让我先在旁边看。",
            "life_event_id": event_id,
        },
    }
    with psycopg.connect(story_index_database) as connection:
        connection.execute("UPDATE story SET life_event_id = NULL WHERE id = %s", (story_id,))
    assert repository.get_opening_history(1)["previous_story"]["life_event_id"] is None

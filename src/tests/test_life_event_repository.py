"""经历写入与故事关联的事务测试；仅使用专用测试库的隔离 schema。"""

import os
from unittest.mock import Mock
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
import pytest

from src.common.migrate import load_migrations
from src.service.life_event import LifeEventRepository
from src.service.life_event.schema import LifeEventSuggestion


@pytest.fixture
def life_event_database():
    test_url = os.getenv("MANJILU_TEST_DATABASE_URL", "").strip()
    if not test_url:
        pytest.skip("Set MANJILU_TEST_DATABASE_URL to a dedicated PostgreSQL test database")
    if not conninfo_to_dict(test_url).get("dbname", "").endswith("_test"):
        pytest.fail("Life event tests require a database name ending in _test", pytrace=False)

    schema = "life_event_repository_" + uuid4().hex
    with psycopg.connect(test_url, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    database_url = make_conninfo(test_url, options=f"-c search_path={schema}")
    try:
        with psycopg.connect(database_url, autocommit=True) as connection:
            for migration in load_migrations():
                connection.execute(migration.sql, prepare=False)
            connection.execute(
                "INSERT INTO users (username, password) VALUES "
                "('event_owner', 'test-password-hash'), ('other_owner', 'test-password-hash')"
            )
            connection.execute(
                "INSERT INTO story (user_id, title, body) VALUES "
                "(1, '初到北京', '离开家乡来到北京。'), "
                "(1, '第一份工作', '在北京找到第一份工作。'), "
                "(2, '另一位用户的故事', '另外的正文。')"
            )
        yield database_url
    finally:
        with psycopg.connect(test_url, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def suggestion(action="create", event_id=None, **changes):
    fields = {
        "action": action, "event_id": event_id, "title": "第一次去北京打工",
        "summary": "1985年离开家乡来到北京。", "life_stage": "青年",
        "time_text": "1985年", "status": "expandable", "reason": "故事讲述打工的开端。",
    }
    if action == "skip":
        for key in ("event_id", "title", "summary", "life_stage", "time_text", "status"):
            fields[key] = None
    fields.update(changes)
    return LifeEventSuggestion(**fields)


def saved_rows(database_url):
    with psycopg.connect(database_url) as connection:
        return (
            connection.execute("SELECT * FROM life_events ORDER BY id").fetchall(),
            connection.execute("SELECT id, user_id, life_event_id FROM story ORDER BY id").fetchall(),
        )


def test_create_saves_event_and_links_only_the_requested_story(life_event_database):
    repository = LifeEventRepository(life_event_database)
    proposal = suggestion()

    result = repository.save_suggestion(1, 1, proposal)

    assert result == {**proposal.model_dump(), "story_id": 1, "event_id": result["event_id"]}
    assert repository.get_life_events(1) == [{
        "id": result["event_id"], "title": proposal.title, "summary": proposal.summary,
        "life_stage": proposal.life_stage, "time_text": proposal.time_text, "status": proposal.status,
    }]
    assert repository.get_life_events(2) == []
    assert saved_rows(life_event_database)[1] == [(1, 1, result["event_id"]), (2, 1, None), (3, 2, None)]


def test_update_saves_complete_summary_and_links_another_story(life_event_database):
    repository = LifeEventRepository(life_event_database)
    event_id = repository.save_suggestion(1, 1, suggestion())["event_id"]
    with psycopg.connect(life_event_database) as connection:
        connection.execute("UPDATE life_events SET updated_at = '2000-01-01' WHERE id = %s", (event_id,))
        created_at, old_updated_at = connection.execute(
            "SELECT created_at, updated_at FROM life_events WHERE id = %s", (event_id,),
        ).fetchone()
    proposal = suggestion("update", event_id, summary="1985年来到北京，随后找到第一份饭店工作。")

    result = repository.save_suggestion(1, 2, proposal)

    assert result == {**proposal.model_dump(), "story_id": 2}
    assert repository.get_life_events(1)[0]["summary"] == proposal.summary
    assert len(repository.get_life_events(1)) == 1
    assert saved_rows(life_event_database)[1] == [(1, 1, event_id), (2, 1, event_id), (3, 2, None)]
    with psycopg.connect(life_event_database) as connection:
        current_created_at, updated_at = connection.execute(
            "SELECT created_at, updated_at FROM life_events WHERE id = %s", (event_id,),
        ).fetchone()
    assert current_created_at == created_at
    assert updated_at > old_updated_at


def test_unchanged_update_only_links_story_and_keeps_event_timestamp(life_event_database):
    repository = LifeEventRepository(life_event_database)
    event_id = repository.save_suggestion(1, 1, suggestion())["event_id"]
    before = saved_rows(life_event_database)[0]

    repository.save_suggestion(1, 2, suggestion("update", event_id))

    assert saved_rows(life_event_database)[0] == before
    assert saved_rows(life_event_database)[1][1] == (2, 1, event_id)


def test_skip_returns_without_opening_database(monkeypatch):
    repository = LifeEventRepository("unused")
    connect = Mock(side_effect=AssertionError("skip 不应连接数据库"))
    monkeypatch.setattr(repository, "_connect", connect)
    proposal = suggestion("skip", reason="无法可靠判断经历归属。")

    assert repository.save_suggestion(1, 1, proposal) == {**proposal.model_dump(), "story_id": 1}
    connect.assert_not_called()


@pytest.mark.parametrize("missing", [False, True])
def test_other_users_or_missing_event_cannot_be_updated(life_event_database, missing):
    repository = LifeEventRepository(life_event_database)
    event_id = repository.save_suggestion(1, 1, suggestion())["event_id"]
    before = saved_rows(life_event_database)

    with pytest.raises(ValueError):
        repository.save_suggestion(2, 3, suggestion("update", event_id + 1000 if missing else event_id))

    assert saved_rows(life_event_database) == before


@pytest.mark.parametrize("action", ["create", "update"])
@pytest.mark.parametrize("story_id", [3, 999], ids=["other-user-story", "missing-story"])
def test_failed_story_lookup_rolls_back_event_changes(life_event_database, action, story_id):
    repository = LifeEventRepository(life_event_database)
    event_id = repository.save_suggestion(1, 1, suggestion())["event_id"]
    before = saved_rows(life_event_database)
    proposal = suggestion(action, event_id if action == "update" else None, summary="本次不应保存的摘要。")

    with pytest.raises(ValueError):
        repository.save_suggestion(1, story_id, proposal)

    assert saved_rows(life_event_database) == before


@pytest.mark.parametrize("action", ["create", "update"])
def test_database_error_linking_story_rolls_back_event_changes(life_event_database, action):
    repository = LifeEventRepository(life_event_database)
    event_id = repository.save_suggestion(1, 1, suggestion())["event_id"]
    with psycopg.connect(life_event_database) as connection:
        connection.execute(
            "ALTER TABLE story ADD CONSTRAINT reject_second_story_link "
            "CHECK (id <> 2 OR life_event_id IS NULL)"
        )
    before = saved_rows(life_event_database)

    with pytest.raises(psycopg.errors.CheckViolation):
        repository.save_suggestion(
            1, 2, suggestion(action, event_id if action == "update" else None, summary="不应提交的修改。"),
        )

    assert saved_rows(life_event_database) == before

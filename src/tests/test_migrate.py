"""完整 schema 初始化与校验；数据库用例仅连接专用测试库创建的临时库。"""

from concurrent.futures import ThreadPoolExecutor
import os
import re
import shutil
import uuid

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from psycopg.conninfo import conninfo_to_dict, make_conninfo
import pytest

from src.common.migrate import (
    MIGRATIONS_DIRECTORY,
    MigrationError,
    _transaction_body,
    apply_migrations,
    check_schema,
    load_migrations,
    main,
)


SCHEMA_FILES = (
    "account/0001_users.sql",
    "interview/0002_interview_sessions.sql",
    "interview/0003_media.sql",
    "memory/0004_user_profiles.sql",
    "memory/0005_life_events.sql",
    "content/0006_chapter.sql",
    "content/0007_story.sql",
    "content/0008_topic.sql",
    "content/0009_story_revisions.sql",
    "content/0010_biography.sql",
    "interview/0011_rtc_calls.sql",
)
BUSINESS_TABLES = {
    "users", "interview_sessions", "media", "user_profiles", "life_events", "chapter", "story", "topic", "story_revisions", "biography", "rtc_calls",
}


@pytest.fixture
def database_url():
    test_url = os.getenv("MANJILU_TEST_DATABASE_URL", "").strip()
    if not test_url:
        pytest.skip("Set MANJILU_TEST_DATABASE_URL to a dedicated PostgreSQL test database")
    if not conninfo_to_dict(test_url).get("dbname", "").endswith("_test"):
        pytest.fail("Schema tests require a database name ending in _test", pytrace=False)
    name = "src_schema_" + uuid.uuid4().hex + "_test"
    with psycopg.connect(test_url, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    try:
        yield make_conninfo(test_url, dbname=name)
    finally:
        with psycopg.connect(test_url, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))


@pytest.fixture
def schema_directory(tmp_path):
    directory = tmp_path / "schema"
    shutil.copytree(MIGRATIONS_DIRECTORY, directory)
    return directory


def current_versions():
    return [item.version for item in load_migrations()]


def context_message(identifier, *, source=None):
    metadata = {"source_message_id": source} if source is not None else {}
    return {"type": "ai", "data": {
        "id": identifier, "content": "保留原文和照片", "additional_kwargs": metadata,
    }}


def test_schema_files_are_complete_ordered_and_keep_relative_category_paths():
    schema = load_migrations()
    assert [item.version for item in schema] == [f"{number:04d}" for number in range(1, 12)]
    assert tuple(item.filename for item in schema) == SCHEMA_FILES
    assert "CREATE FUNCTION interview_context_ids_valid" in schema[1].sql
    assert "interview_sessions_context_ids_check" in schema[1].sql
    assert "DROP COLUMN messages" not in schema[1].sql
    for item in schema[:8]:
        assert not re.search(r"^\s*(?:ALTER|INSERT|UPDATE|DELETE|DROP)\s", item.sql, re.MULTILINE | re.IGNORECASE)
        created_tables = re.findall(r"\bCREATE\s+TABLE\s+([a-z_]+)", item.sql, re.IGNORECASE)
        assert len(created_tables) == 1
        assert created_tables[0] in BUSINESS_TABLES


def test_transaction_wrapper_removal_preserves_quoted_and_nested_sql():
    source = """-- BEGIN; ignored comment
        /* outer /* nested ; COMMIT; */ comment */ BEGIN;
        DO $body$ BEGIN RAISE NOTICE 'COMMIT;'; END; $body$;
        SELECT 'it''s; done', 'COMMIT;', "COMMIT;";
        COMMIT; -- last comment
    """
    body = _transaction_body(source)
    assert "DO $body$ BEGIN RAISE NOTICE 'COMMIT;'; END; $body$;" in body
    assert "SELECT 'it''s; done'" in body
    assert _transaction_body("SELECT 1; -- COMMIT;\n") == "SELECT 1; -- COMMIT;\n"


@pytest.mark.parametrize("source", [
    "BEGIN; SELECT 1;", "SELECT 1; COMMIT;", "SELECT 1; COMMIT; SELECT 2;",
    "BEGIN; SELECT 1; COMMIT; SELECT 2;", "BEGIN; BEGIN; SELECT 1; COMMIT; COMMIT;",
    "SELECT 1; END;", "START TRANSACTION; SELECT 1; COMMIT;",
    "SELECT 'unterminated", "/* unterminated", "DO $$ unterminated", "BEGIN; COMMIT;",
])
def test_unmanaged_transaction_control_or_unterminated_sql_is_rejected(source):
    with pytest.raises(MigrationError):
        _transaction_body(source)


def test_missing_or_duplicate_schema_version_is_rejected_across_categories(schema_directory):
    first = schema_directory / SCHEMA_FILES[0]
    duplicate = schema_directory / "content/0001_duplicate.sql"
    duplicate.write_bytes(first.read_bytes())
    with pytest.raises(MigrationError, match="unique and consecutive"):
        load_migrations(schema_directory)
    duplicate.unlink()
    first.unlink()
    with pytest.raises(MigrationError, match="unique and consecutive"):
        load_migrations(schema_directory)


def test_cli_requires_only_current_database_variable_and_hides_connection_details(monkeypatch, capsys):
    monkeypatch.delenv("MANJILU_DATABASE_URL", raising=False)
    monkeypatch.setenv("MANJI_DATABASE_URL", "old-app-must-not-be-used")
    assert main([]) == 1
    assert capsys.readouterr().err == "MANJILU_DATABASE_URL is required\n"
    monkeypatch.setenv("MANJILU_DATABASE_URL", "private-database-password")

    def unavailable(*args, **kwargs):
        raise psycopg.OperationalError("private-database-password")

    monkeypatch.setattr("src.common.migrate.psycopg.connect", unavailable)
    assert main(["check"]) == 1
    assert "private-database-password" not in capsys.readouterr().err


def test_fresh_schema_creates_empty_business_tables_and_repeat_does_not_write(database_url):
    with psycopg.connect(database_url, autocommit=True) as connection:
        with pytest.raises(MigrationError, match="not initialized"):
            check_schema(connection)
        assert apply_migrations(connection) == current_versions()
        ledger = connection.execute("SELECT * FROM src_schema_migrations ORDER BY version").fetchall()
        assert len(ledger) == len(load_migrations())
        assert tuple(row[1] for row in ledger) == SCHEMA_FILES
        tables = connection.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
        ).fetchall()
        assert {row[0] for row in tables} == BUSINESS_TABLES | {"src_schema_migrations"}
        assert connection.execute("SELECT to_regclass('interview_context_id_migration_backup')").fetchone() == (None,)
        for table in BUSINESS_TABLES:
            assert connection.execute(sql.SQL("SELECT COUNT(*) FROM {}").format(sql.Identifier(table))).fetchone() == (0,)
        foreign_keys = connection.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = 'story'::regclass AND contype = 'f'",
        ).fetchall()
        assert (
            "FOREIGN KEY (life_event_id) REFERENCES life_events(id) ON DELETE RESTRICT",
        ) in foreign_keys

        user_id = connection.execute(
            "INSERT INTO users (username, password) VALUES ('synthetic', 'synthetic-hash') RETURNING id",
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO story (user_id, title, body) VALUES (%s, '已有标题', '已有正文')", (user_id,),
        )
        before = connection.execute("SELECT * FROM story").fetchall()
        assert apply_migrations(connection) == []
        assert connection.execute("SELECT * FROM src_schema_migrations ORDER BY version").fetchall() == ledger
        assert connection.execute("SELECT * FROM story").fetchall() == before
        assert connection.execute("SELECT COUNT(*) FROM chapter").fetchone() == (0,)
        with connection.transaction():
            connection.execute("SET TRANSACTION READ ONLY")
            check_schema(connection)


def test_chapter_and_topic_defaults_and_required_description_and_relationship(database_url):
    with psycopg.connect(database_url, autocommit=True) as connection:
        apply_migrations(connection)
        for table, expected_columns in {
            "chapter": {"id", "title", "sort_order", "is_enabled"},
            "topic": {"id", "chapter_id", "title", "description", "sort_order", "is_enabled"},
        }.items():
            columns = connection.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = %s", (table,),
            ).fetchall()
            assert {row[0] for row in columns} == expected_columns

        chapter_id, sort_order, is_enabled = connection.execute(
            "INSERT INTO chapter (title) VALUES ('童年') RETURNING id, sort_order, is_enabled",
        ).fetchone()
        assert chapter_id > 0
        assert (sort_order, is_enabled) == (0, True)
        topic_id, sort_order, is_enabled = connection.execute(
            "INSERT INTO topic (chapter_id, title, description) VALUES (%s, '童年的家', '讲讲小时候住过的家') "
            "RETURNING id, sort_order, is_enabled", (chapter_id,),
        ).fetchone()
        assert topic_id > 0
        assert (sort_order, is_enabled) == (0, True)

        with pytest.raises(psycopg.errors.NotNullViolation), connection.transaction():
            connection.execute(
                "INSERT INTO topic (chapter_id, title) VALUES (%s, '缺少介绍')", (chapter_id,),
            )
        for description, error in [
            (None, psycopg.errors.NotNullViolation),
            ("", psycopg.errors.CheckViolation),
            ("   ", psycopg.errors.CheckViolation),
        ]:
            with pytest.raises(error), connection.transaction():
                connection.execute(
                    "INSERT INTO topic (chapter_id, title, description) VALUES (%s, '无效介绍', %s)",
                    (chapter_id, description),
                )
        with pytest.raises(psycopg.errors.ForeignKeyViolation), connection.transaction():
            connection.execute(
                "INSERT INTO topic (chapter_id, title, description) VALUES (%s, '无效章节', '卡片介绍')",
                (chapter_id + 1,),
            )
        with pytest.raises((psycopg.errors.ForeignKeyViolation, psycopg.errors.RestrictViolation)), connection.transaction():
            connection.execute("DELETE FROM chapter WHERE id = %s", (chapter_id,))
        assert connection.execute(
            "SELECT chapter_id FROM topic WHERE id = %s", (topic_id,),
        ).fetchone() == (chapter_id,)
        assert connection.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = 'topic'::regclass AND contype = 'f'",
        ).fetchall() == [("FOREIGN KEY (chapter_id) REFERENCES chapter(id) ON DELETE RESTRICT",)]


def test_context_constraint_accepts_integer_ids_and_preserves_metadata(database_url):
    valid_contexts = [
        [], [context_message(1)],
        [context_message(1), context_message(2, source=1)],
        [context_message(9223372036854775807)],
    ]
    valid_contexts[2][0]["data"]["additional_kwargs"]["media_ids"] = [17]
    with psycopg.connect(database_url, autocommit=True) as connection:
        apply_migrations(connection)
        user_id = connection.execute(
            "INSERT INTO users (username, password) VALUES ('synthetic', 'synthetic-hash') RETURNING id",
        ).fetchone()[0]
        for context in valid_contexts:
            assert connection.execute(
                "INSERT INTO interview_sessions (user_id, context) VALUES (%s, %s) RETURNING context",
                (user_id, Jsonb(context)),
            ).fetchone() == (context,)


def test_context_constraint_rejects_invalid_ids_and_dangling_references(database_url):
    invalid_contexts = [
        {}, [context_message("uuid-original")], [context_message("1")],
        [context_message(True)], [context_message(None)],
        [context_message(0)], [context_message(-1)], [context_message(1.5)],
        [context_message(9223372036854775808)],
        [context_message(1), context_message(1)],
        [context_message(1), context_message(2, source="1")],
        [context_message(1, source=2)],
        [{"type": "ai", "data": "broken"}],
    ]
    with psycopg.connect(database_url, autocommit=True) as connection:
        apply_migrations(connection)
        user_id = connection.execute(
            "INSERT INTO users (username, password) VALUES ('synthetic', 'synthetic-hash') RETURNING id",
        ).fetchone()[0]
        original = [context_message(1)]
        session_id = connection.execute(
            "INSERT INTO interview_sessions (user_id, context) VALUES (%s, %s) RETURNING id",
            (user_id, Jsonb(original)),
        ).fetchone()[0]
        for invalid in invalid_contexts:
            with pytest.raises(psycopg.errors.CheckViolation), connection.transaction():
                connection.execute(
                    "UPDATE interview_sessions SET context = %s WHERE id = %s", (Jsonb(invalid), session_id),
                )
            assert connection.execute(
                "SELECT context FROM interview_sessions WHERE id = %s", (session_id,),
            ).fetchone() == (original,)


def test_nonempty_database_is_rejected_even_when_objects_are_in_another_schema(database_url):
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute("CREATE SCHEMA old_app")
        connection.execute("CREATE TABLE old_app.users (id TEXT PRIMARY KEY)")
        connection.execute("INSERT INTO old_app.users VALUES ('existing-user')")
        with pytest.raises(MigrationError, match="non-empty database"):
            apply_migrations(connection)
        assert connection.execute("SELECT * FROM old_app.users").fetchall() == [("existing-user",)]
        assert connection.execute("SELECT to_regclass('src_schema_migrations')").fetchone() == (None,)


def test_changed_schema_file_is_rejected_for_an_initialized_database(database_url, schema_directory):
    with psycopg.connect(database_url, autocommit=True) as connection:
        apply_migrations(connection)
        ledger = connection.execute("SELECT * FROM src_schema_migrations ORDER BY version").fetchall()
        first = schema_directory / SCHEMA_FILES[0]
        first.write_bytes(first.read_bytes() + b"\n-- changed schema file\n")
        with pytest.raises(MigrationError, match="checksum"):
            apply_migrations(connection, directory=schema_directory)
        with pytest.raises(MigrationError, match="checksum"):
            check_schema(connection, directory=schema_directory)
        assert connection.execute("SELECT * FROM src_schema_migrations ORDER BY version").fetchall() == ledger


def test_failure_rolls_back_all_tables_function_and_ledger(database_url, schema_directory):
    final_file = schema_directory / SCHEMA_FILES[-1]
    final_file.write_text(final_file.read_text(encoding="utf-8") + "\nSELECT missing_column;\n", encoding="utf-8")
    with psycopg.connect(database_url, autocommit=True) as connection:
        with pytest.raises(psycopg.errors.UndefinedColumn):
            apply_migrations(connection, directory=schema_directory)
        assert connection.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
        ).fetchall() == []
        assert connection.execute("SELECT to_regprocedure('interview_context_ids_valid(jsonb)')").fetchone() == (None,)
        assert apply_migrations(connection) == current_versions()


@pytest.mark.parametrize("table", ["user_profiles", "life_events", "topic"])
def test_schema_check_requires_memory_and_topic_tables(database_url, table):
    with psycopg.connect(database_url, autocommit=True) as connection:
        apply_migrations(connection)
        connection.execute(sql.SQL("DROP TABLE {} CASCADE").format(sql.Identifier(table)))
        with pytest.raises(MigrationError, match="incomplete"):
            check_schema(connection)


@pytest.mark.parametrize("table,column", [
    ("story", "summary"), ("user_profiles", "profile_data"), ("life_events", "summary"),
    ("chapter", "is_enabled"), ("topic", "description"),
])
def test_schema_check_detects_missing_application_column(database_url, table, column):
    with psycopg.connect(database_url, autocommit=True) as connection:
        apply_migrations(connection)
        connection.execute(sql.SQL("ALTER TABLE {} DROP COLUMN {}").format(sql.Identifier(table), sql.Identifier(column)))
        with pytest.raises(MigrationError, match="incomplete"):
            check_schema(connection)


def test_concurrent_initializations_serialize_and_leave_business_tables_empty(database_url):
    def initialize():
        with psycopg.connect(database_url, autocommit=True) as connection:
            return apply_migrations(connection)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: initialize(), range(2)))
    assert sorted(map(len, results)) == [0, len(load_migrations())]
    with psycopg.connect(database_url) as connection:
        assert connection.execute("SELECT COUNT(*) FROM chapter").fetchone() == (0,)


def test_cli_initialize_and_check_succeed(database_url, monkeypatch, capsys):
    monkeypatch.setenv("MANJILU_DATABASE_URL", database_url)
    assert main([]) == 0
    assert f'"{current_versions()[-1]}"' in capsys.readouterr().out
    for command in ("init", "migrate"):
        assert main([command]) == 0
        assert capsys.readouterr().out.strip() == '{"applied_versions": []}'
    assert main(["check"]) == 0
    assert capsys.readouterr().out.strip() == '{"schema_valid": true}'


def test_incremental_revision_upgrade_preserves_existing_stories_and_history(database_url):
    from src.common.migrate import LEDGER_TABLE
    old_schema = load_migrations()[:8]
    with psycopg.connect(database_url, autocommit=True) as connection:
        with connection.transaction():
            connection.execute('CREATE TABLE src_schema_migrations (version TEXT PRIMARY KEY, filename TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)')
            for migration in old_schema:
                connection.execute(migration.sql, prepare=False)
                connection.execute('INSERT INTO src_schema_migrations(version,filename,checksum) VALUES (%s,%s,%s)',
                                   (migration.version, migration.filename, migration.checksum))
            user_id = connection.execute("INSERT INTO users(username,password) VALUES('upgrade-test','hash') RETURNING id").fetchone()[0]
            context = [context_message(1)]
            session_id = connection.execute('INSERT INTO interview_sessions(user_id,context) VALUES(%s,%s) RETURNING id',
                                            (user_id, Jsonb(context))).fetchone()[0]
            story_id = connection.execute("INSERT INTO story(user_id,title,body,source_session_id) VALUES(%s,'旧标题','旧正文',%s) RETURNING id",
                                          (user_id,str(session_id))).fetchone()[0]
        before = connection.execute('SELECT title,body,source_session_id,create_time FROM story WHERE id=%s',(story_id,)).fetchone()
        old_ledger = connection.execute('SELECT * FROM src_schema_migrations ORDER BY version').fetchall()
        assert apply_migrations(connection) == ['0009', '0010', '0011']
        assert connection.execute('SELECT title,body,source_session_id,create_time FROM story WHERE id=%s',(story_id,)).fetchone() == before
        assert connection.execute('SELECT version,updated_time=create_time FROM story WHERE id=%s',(story_id,)).fetchone() == (1,True)
        assert connection.execute('SELECT context FROM interview_sessions WHERE id=%s',(session_id,)).fetchone() == (context,)
        assert connection.execute('SELECT * FROM src_schema_migrations ORDER BY version LIMIT 8').fetchall() == old_ledger
        assert connection.execute('SELECT COUNT(*) FROM story_revisions').fetchone() == (0,)
        assert connection.execute('SELECT COUNT(*) FROM biography').fetchone() == (0,)
        assert apply_migrations(connection) == []
        check_schema(connection)


def test_biography_upgrade_keeps_supplemented_stories_unchanged(database_url):
    original = {'title': '初稿标题', 'body': '初稿正文', 'chapter_id': None, 'photo_layout': [], 'version': 1}
    with psycopg.connect(database_url, autocommit=True) as connection:
        with connection.transaction():
            connection.execute('CREATE TABLE src_schema_migrations (version TEXT PRIMARY KEY, filename TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)')
            for migration in load_migrations()[:9]:
                connection.execute(migration.sql, prepare=False)
                connection.execute('INSERT INTO src_schema_migrations(version,filename,checksum) VALUES (%s,%s,%s)',
                                   (migration.version, migration.filename, migration.checksum))
            owner = connection.execute("INSERT INTO users(username,password) VALUES('biography-upgrade','hash') RETURNING id").fetchone()[0]
            story_id = connection.execute("INSERT INTO story(user_id,title,body,version) VALUES(%s,'新版标题','补充后的正文',2) RETURNING id", (owner,)).fetchone()[0]
            connection.execute(
                "INSERT INTO story_revisions(user_id,story_id,source_session_id,base_version,base_story,original_story,title,body,applied_version,status) "
                "VALUES(%s,%s,'supplement',1,%s,%s,'新版标题','补充后的正文',2,'completed')",
                (owner, story_id, Jsonb(original), Jsonb(original)),
            )
        before = connection.execute('SELECT * FROM story WHERE id=%s', (story_id,)).fetchone()
        revision = connection.execute('SELECT * FROM story_revisions WHERE story_id=%s', (story_id,)).fetchone()
        assert apply_migrations(connection) == ['0010', '0011']
        assert connection.execute('SELECT * FROM story WHERE id=%s', (story_id,)).fetchone() == before
        assert connection.execute('SELECT * FROM story_revisions WHERE story_id=%s', (story_id,)).fetchone() == revision
        assert connection.execute('SELECT COUNT(*) FROM biography').fetchone() == (0,)
        assert apply_migrations(connection) == []


def test_rtc_metadata_upgrade_preserves_existing_interview_and_story(database_url):
    with psycopg.connect(database_url, autocommit=True) as connection:
        with connection.transaction():
            # 保留历史 0010 -> 0011 升级检查，不依赖已移除的 RTC 服务。
            connection.execute(
                "CREATE TABLE src_schema_migrations (version TEXT PRIMARY KEY, filename TEXT NOT NULL, "
                "checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            )
            for migration in load_migrations()[:10]:
                connection.execute(migration.sql, prepare=False)
                connection.execute(
                    "INSERT INTO src_schema_migrations(version, filename, checksum) VALUES (%s, %s, %s)",
                    (migration.version, migration.filename, migration.checksum),
                )
            owner = connection.execute(
                "INSERT INTO users (username, password) VALUES ('rtc-upgrade', 'hash') RETURNING id",
            ).fetchone()[0]
            chapter = connection.execute(
                "INSERT INTO chapter (title) VALUES ('童年') RETURNING id",
            ).fetchone()[0]
            session = connection.execute(
                "INSERT INTO interview_sessions (user_id) VALUES (%s) RETURNING *", (owner,),
            ).fetchone()
            story = connection.execute(
                "INSERT INTO story (user_id, title, body, chapter_id) VALUES (%s, '旧标题', '旧正文', %s) RETURNING *",
                (owner, chapter),
            ).fetchone()
        assert apply_migrations(connection) == ["0011"]
        assert connection.execute("SELECT * FROM interview_sessions").fetchall() == [session]
        assert connection.execute("SELECT * FROM story").fetchall() == [story]
        assert connection.execute("SELECT COUNT(*) FROM rtc_calls").fetchone() == (0,)
        assert apply_migrations(connection) == []
        check_schema(connection)

        # 当前服务不使用 RTC 表；历史迁移仍保留，就绪检查不再依赖该表。
        connection.execute("DROP TABLE rtc_calls")
        check_schema(connection)

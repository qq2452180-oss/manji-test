"""新库结构初始化：python -m src.common.migrate [init|check]。

schema 目录按模块保存完整建表 SQL，编号只决定依赖顺序。
仅使用 MANJILU_DATABASE_URL；init 要求空库，check 只读校验。
migrate 可追加执行尚未安装的编号 SQL；已安装文件必须保持校验和不变。
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sys

import psycopg
from psycopg.rows import dict_row


SCHEMA_DIRECTORY = Path(__file__).with_name("schema")
# 保留 Python 调用方使用的名称；内容已统一为新库建表基线。
MIGRATIONS_DIRECTORY = SCHEMA_DIRECTORY
LEDGER_TABLE = "src_schema_migrations"
REQUIRED_COLUMNS = {
    "users": {"id", "username", "password", "token", "is_guest", "create_time"},
    "media": {"id", "user_id", "session_id", "file_path", "create_time"},
    "interview_sessions": {
        "id", "user_id", "resume_mode", "context", "create_time", "update_time", "finish_time",
    },
    "story": {
        "id", "user_id", "title", "body", "summary", "create_time", "chapter_id",
        "source_session_id", "photo_layout", "profile_processed", "life_event_processed", "life_event_id",
        "version", "updated_time",
    },
    "story_revisions": {
        "id", "user_id", "story_id", "source_session_id", "base_version", "applied_version",
        "attempt", "base_story", "original_story", "title", "body", "photo_layout", "summary",
        "profile_processed", "life_event_processed", "life_event_id", "status", "create_time", "update_time",
    },
    "biography": {"user_id", "body", "updated_time"},
    "chapter": {"id", "title", "sort_order", "is_enabled"},
    "topic": {"id", "chapter_id", "title", "description", "sort_order", "is_enabled"},
    "user_profiles": {"user_id", "profile_data", "created_at", "updated_at"},
    "life_events": {
        "id", "user_id", "title", "summary", "life_stage", "time_text", "status",
        "created_at", "updated_at",
    },
}


class MigrationError(RuntimeError):
    """The target database or migration history is not safe for this src version."""


@dataclass(frozen=True)
class Migration:
    version: str
    filename: str
    checksum: str
    sql: str


def _statements(source: str) -> list[tuple[int, int, str]]:
    """Find SQL statement boundaries, ignoring comments and quoted SQL bodies."""
    statements = []
    start = position = 0
    words = []
    while position < len(source):
        if source.startswith("--", position):
            newline = source.find("\n", position + 2)
            position = len(source) if newline < 0 else newline + 1
            words.append(" ")
            continue
        if source.startswith("/*", position):
            depth = 1
            position += 2
            while position < len(source) and depth:
                if source.startswith("/*", position):
                    depth += 1
                    position += 2
                elif source.startswith("*/", position):
                    depth -= 1
                    position += 2
                else:
                    position += 1
            if depth:
                raise MigrationError("Unterminated SQL comment")
            words.append(" ")
            continue
        character = source[position]
        dollar = re.match(r"\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$", source[position:])
        if character in ("'", '"') or dollar:
            quote = dollar.group() if dollar else character
            position += len(quote)
            while True:
                if position >= len(source):
                    raise MigrationError("Unterminated SQL quoted value")
                if source.startswith(quote, position):
                    position += len(quote)
                    if not dollar and source.startswith(quote, position):
                        position += len(quote)
                        continue
                    break
                if not dollar and character == "'" and source[position] == "\\":
                    position += 2
                else:
                    position += 1
            words.append(" <quoted> ")
            continue
        position += 1
        if character == ";":
            if "".join(words).strip():
                statements.append((start, position, "".join(words).strip().upper()))
            start = position
            words = []
        else:
            words.append(character)
    if "".join(words).strip():
        statements.append((start, position, "".join(words).strip().upper()))
    return statements


def _transaction_body(source: str) -> str:
    """The runner owns the transaction; remove only an outer BEGIN/COMMIT pair."""
    statements = _statements(source)
    if not statements:
        raise MigrationError("Empty migration")
    if statements[0][2] == "BEGIN" and statements[-1][2] == "COMMIT":
        source = source[statements[0][1]:statements[-1][0]]
        statements = statements[1:-1]
    if not statements:
        raise MigrationError("Empty migration")
    for _, _, statement in statements:
        if statement.split()[0] in {
            "BEGIN", "START", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE", "PREPARE",
        }:
            raise MigrationError("Migration transaction control must be one outer BEGIN/COMMIT pair")
    return source


def load_migrations(directory: Path = MIGRATIONS_DIRECTORY) -> tuple[Migration, ...]:
    migrations = []
    for path in sorted(directory.rglob("[0-9][0-9][0-9][0-9]_*.sql"), key=lambda path: path.name):
        content = path.read_bytes()
        migrations.append(Migration(
            path.name[:4], path.relative_to(directory).as_posix(), hashlib.sha256(content).hexdigest(),
            _transaction_body(content.decode("utf-8")),
        ))
    versions = [item.version for item in migrations]
    if not versions or versions != [f"{number:04d}" for number in range(1, len(versions) + 1)]:
        raise MigrationError("Migration versions must be unique and consecutive starting at 0001")
    return tuple(migrations)


def _installed(cursor) -> list[dict] | None:
    exists = cursor.execute(
        "SELECT 1 FROM information_schema.tables "
        "WHERE table_schema = current_schema() AND table_name = %s", (LEDGER_TABLE,),
    ).fetchone()
    if exists is None:
        return None
    return cursor.execute(
        "SELECT version, filename, checksum FROM src_schema_migrations ORDER BY version",
    ).fetchall()


def _validate_history(installed: list[dict], migrations: tuple[Migration, ...], *, complete: bool) -> None:
    if len(installed) > len(migrations) or (complete and len(installed) != len(migrations)):
        raise MigrationError("src database migration version does not match this application")
    for actual, expected in zip(installed, migrations):
        if (actual["version"], actual["filename"], actual["checksum"]) != (
            expected.version, expected.filename, expected.checksum,
        ):
            raise MigrationError("src migration version, filename, or checksum does not match")


def _validate_columns(cursor) -> None:
    columns: dict[str, set[str]] = {}
    for row in cursor.execute(
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE table_schema = current_schema()",
    ).fetchall():
        columns.setdefault(row["table_name"], set()).add(row["column_name"])
    if any(not required.issubset(columns.get(table, set())) for table, required in REQUIRED_COLUMNS.items()):
        raise MigrationError("src database business tables or columns are incomplete")


def check_schema(connection: psycopg.Connection, *, directory: Path = MIGRATIONS_DIRECTORY) -> None:
    """Read-only readiness check; never creates a table or upgrades the database."""
    migrations = load_migrations(directory)
    with connection.cursor(row_factory=dict_row) as cursor:
        installed = _installed(cursor)
        if installed is None:
            raise MigrationError("src database is not initialized; run python -m src.common.migrate init")
        _validate_history(installed, migrations, complete=True)
        _validate_columns(cursor)


def apply_migrations(connection: psycopg.Connection, *, directory: Path = MIGRATIONS_DIRECTORY) -> list[str]:
    """Apply pending SQL and its ledger entries atomically under a database lock."""
    migrations = load_migrations(directory)
    applied = []
    with connection.transaction(), connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute("SET LOCAL lock_timeout = '30s'")
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended("
            "current_database() || ':src:migrations', 0))",
        )
        installed = _installed(cursor)
        if installed is None:
            existing = cursor.execute(
                "SELECT 1 FROM pg_class AS relation JOIN pg_namespace AS namespace "
                "ON namespace.oid = relation.relnamespace "
                "WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema' "
                "AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') LIMIT 1",
            ).fetchone()
            if existing is not None:
                raise MigrationError("Refusing to initialize a non-empty database; create a new src database")
            cursor.execute("""
                CREATE TABLE src_schema_migrations (
                    version TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """)
            installed = []
        _validate_history(installed, migrations, complete=False)
        pending = list(migrations[len(installed):])
        for migration in pending:
            cursor.execute(migration.sql, prepare=False)
            cursor.execute(
                "INSERT INTO src_schema_migrations (version, filename, checksum) VALUES (%s, %s, %s)",
                (migration.version, migration.filename, migration.checksum),
            )
            applied.append(migration.version)
        _validate_columns(cursor)
    return sorted(applied)


def main(argv: list[str] | None = None, *, database_url: str | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "migrate", "check"), nargs="?", default="init")
    args = parser.parse_args(argv)
    database_url = (os.getenv("MANJILU_DATABASE_URL", "") if database_url is None else database_url).strip()
    if not database_url:
        print("MANJILU_DATABASE_URL is required", file=sys.stderr)
        return 1
    try:
        with psycopg.connect(database_url, autocommit=True, connect_timeout=10) as connection:
            if args.command in ("init", "migrate"):
                report = {"applied_versions": apply_migrations(connection)}
            else:
                check_schema(connection)
                report = {"schema_valid": True}
        print(json.dumps(report))
        return 0
    except MigrationError as error:
        print(f"Migration rejected: {error}", file=sys.stderr)
    except (psycopg.Error, OSError, ValueError):
        # Connection exceptions may contain DSNs or credentials; do not echo them.
        print("Migration failed; verify database connectivity and migration SQL", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

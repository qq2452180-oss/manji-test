"""画像保存的事务和并发检查；集成测试只在专用测试库的隔离 schema 中运行。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import os
from threading import Barrier
from unittest.mock import MagicMock
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
import pytest

from src.common.migrate import load_migrations
from src.service.profile.repository import ProfileRepository


@pytest.fixture
def profile_database():
    test_url = os.getenv("MANJILU_TEST_DATABASE_URL", "").strip()
    if not test_url:
        pytest.skip("Set MANJILU_TEST_DATABASE_URL to a dedicated PostgreSQL test database")
    if not conninfo_to_dict(test_url).get("dbname", "").endswith("_test"):
        pytest.fail("Profile tests require a database name ending in _test", pytrace=False)

    schema = "profile_repository_" + uuid4().hex
    with psycopg.connect(test_url, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    database_url = make_conninfo(test_url, options=f"-c search_path={schema}")
    try:
        with psycopg.connect(database_url) as connection:
            for migration in load_migrations():
                connection.execute(migration.sql, prepare=False)
            connection.execute(
                "INSERT INTO users (username, password) VALUES "
                "('profile_owner', 'test-password-hash'), ('other_owner', 'test-password-hash')"
            )
        yield database_url
    finally:
        with psycopg.connect(test_url, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def test_first_save_and_update_preserve_creation_time(profile_database):
    repository = ProfileRepository(profile_database)
    original = {"basic_background": {"birthplace": "扬州"}}
    updated = {"basic_background": {"birthplace": "扬州", "current_location": "杭州"}}

    assert repository.save_profile(1, original, expected_profile={}) == original
    assert repository.get_profile(1) == original
    assert repository.get_profile(2) is None
    with psycopg.connect(profile_database) as connection:
        created_at = connection.execute(
            "SELECT created_at FROM user_profiles WHERE user_id = 1",
        ).fetchone()[0]
        connection.execute(
            "UPDATE user_profiles SET updated_at = '2000-01-01 00:00:00+00' WHERE user_id = 1",
        )

    assert repository.save_profile(1, updated, expected_profile=original) == updated
    with psycopg.connect(profile_database) as connection:
        saved_created_at, saved_updated_at = connection.execute(
            "SELECT created_at, updated_at FROM user_profiles WHERE user_id = 1",
        ).fetchone()
    assert saved_created_at == created_at
    assert saved_updated_at > datetime(2000, 1, 1, tzinfo=timezone.utc)


def test_existing_empty_profile_can_receive_first_facts(profile_database):
    repository = ProfileRepository(profile_database)
    profile = {"family_background": {"siblings_count": 0}}
    repository.save_profile(1, {}, expected_profile={})
    assert repository.save_profile(1, profile, expected_profile={}) == profile

    with pytest.raises(ValueError, match="画像已变化"):
        repository.save_profile(1, {"basic_background": {"birthplace": "苏州"}}, expected_profile={})
    assert repository.get_profile(1) == profile


def test_stale_snapshot_and_deleted_profile_cannot_be_overwritten(profile_database):
    repository = ProfileRepository(profile_database)
    original = {"basic_background": {"current_location": "合肥"}}
    current = {"basic_background": {"current_location": "杭州"}}
    repository.save_profile(1, original, expected_profile={})
    repository.save_profile(1, current, expected_profile=original)

    with pytest.raises(ValueError, match="画像已变化"):
        repository.save_profile(1, {"basic_background": {"current_location": "南京"}}, expected_profile=original)
    assert repository.get_profile(1) == current

    with psycopg.connect(profile_database) as connection:
        connection.execute("DELETE FROM user_profiles WHERE user_id = 1")
    with pytest.raises(ValueError, match="画像已变化"):
        repository.save_profile(1, original, expected_profile=current)
    assert repository.get_profile(1) is None


@pytest.mark.parametrize("initial", [None, {"basic_background": {"current_location": "合肥"}}])
def test_concurrent_saves_accept_only_one_snapshot(profile_database, initial):
    repository = ProfileRepository(profile_database)
    if initial is not None:
        repository.save_profile(1, initial, expected_profile={})
    ready = Barrier(2)

    def save(city):
        profile = {"basic_background": {"current_location": city}}
        ready.wait(timeout=5)
        try:
            return repository.save_profile(1, profile, expected_profile=initial or {})
        except ValueError:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(save, ["杭州", "南京"]))
    successful = [result for result in results if result is not None]
    assert len(successful) == 1
    assert repository.get_profile(1) == successful[0]


def test_database_error_rolls_back_and_preserves_saved_profile(profile_database):
    repository = ProfileRepository(profile_database)
    original = {"basic_background": {"birthplace": "扬州"}}
    repository.save_profile(1, original, expected_profile={})
    with psycopg.connect(profile_database) as connection:
        before = connection.execute("SELECT * FROM user_profiles WHERE user_id = 1").fetchone()

    with pytest.raises(psycopg.errors.CheckViolation):
        repository.save_profile(1, [], expected_profile=original)

    with psycopg.connect(profile_database) as connection:
        after = connection.execute("SELECT * FROM user_profiles WHERE user_id = 1").fetchone()
    assert after == before
    assert repository.get_profile(1) == original


def test_conflict_leaves_transaction_with_original_value_error(monkeypatch):
    repository = ProfileRepository("unused")
    connection = MagicMock()
    connection.__enter__.return_value = connection
    connection.execute.return_value.fetchone.return_value = None
    monkeypatch.setattr(repository, "_connect", lambda: connection)

    with pytest.raises(ValueError, match="画像已变化") as error:
        repository.save_profile(1, {"basic_background": {"birthplace": "扬州"}}, expected_profile={})
    assert connection.__exit__.call_args.args[:2] == (ValueError, error.value)


def test_commit_error_is_not_reported_as_a_saved_profile(monkeypatch):
    repository = ProfileRepository("unused")
    connection = MagicMock()
    connection.__enter__.return_value = connection
    connection.execute.return_value.fetchone.return_value = {"profile_data": {}}
    failure = psycopg.OperationalError("commit failed")
    connection.__exit__.side_effect = failure
    monkeypatch.setattr(repository, "_connect", lambda: connection)

    with pytest.raises(psycopg.OperationalError) as error:
        repository.save_profile(1, {}, expected_profile={})
    assert error.value is failure

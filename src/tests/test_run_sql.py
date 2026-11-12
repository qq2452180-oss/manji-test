"""SQL 工具回归检查；所有数据库连接均使用替身。"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import psycopg
from psycopg.conninfo import conninfo_to_dict
import pytest

from src.tools import run_sql


@pytest.fixture
def database(monkeypatch, tmp_path):
    monkeypatch.setattr(run_sql, "SRC_DIR", tmp_path)
    monkeypatch.setenv("MANJILU_DATABASE_URL", "postgresql://fixture/database")
    connection = MagicMock()
    connection.__enter__.return_value = connection
    cursor = connection.cursor.return_value
    cursor.__enter__.return_value = cursor
    connect = MagicMock(return_value=connection)
    installed = MagicMock(return_value=None)
    apply_migrations = MagicMock()
    monkeypatch.setattr(run_sql.psycopg, "connect", connect)
    monkeypatch.setattr(run_sql.migrate, "_installed", installed)
    monkeypatch.setattr(run_sql.migrate, "apply_migrations", apply_migrations)
    return SimpleNamespace(
        connection=connection, cursor=cursor, connect=connect,
        installed=installed, apply_migrations=apply_migrations,
    )


@pytest.mark.parametrize("dry_run", [False, True])
def test_explicit_file_executes_only_selected_sql_without_prompting(
    database, monkeypatch, capsys, dry_run,
):
    prompt = MagicMock(side_effect=AssertionError("--file must not prompt"))
    monkeypatch.setattr("builtins.input", prompt)
    args = ["--file", "memory/0004_user_profiles.sql"]
    assert run_sql.main([*args, "--dry-run"] if dry_run else args) == 0
    statements = [call.args[0] for call in database.cursor.execute.call_args_list]
    business_sql = [statement for statement in statements if not statement.startswith("SET LOCAL")]
    assert len(business_sql) == 1
    assert "CREATE TABLE user_profiles" in business_sql[0]
    database.apply_migrations.assert_not_called()
    database.connection.transaction.assert_called_once_with(force_rollback=dry_run)
    assert database.cursor.execute.call_args.kwargs == {"prepare": False}
    assert ("事务已回滚" if dry_run else "事务已提交") in capsys.readouterr().out
    prompt.assert_not_called()


@pytest.mark.parametrize("selection", ["2", "0002_topics.sql", "absolute_path"])
def test_interactive_selection_executes_another_sql_file(database, monkeypatch, tmp_path, selection):
    directory = tmp_path / "migrations"
    directory.mkdir()
    selected_path = directory / "0002_topics.sql"
    selected_sql = "CREATE TABLE topics (id BIGINT PRIMARY KEY);"
    selected_path.write_text(selected_sql, encoding="utf-8")
    (directory / "0001_unselected.sql").write_text("SELECT 1;", encoding="utf-8")
    monkeypatch.setattr(run_sql.migrate, "MIGRATIONS_DIRECTORY", directory)

    def choose(_prompt):
        database.connect.assert_not_called()
        return str(selected_path) if selection == "absolute_path" else selection

    monkeypatch.setattr("builtins.input", choose)
    assert run_sql.main([]) == 0
    business_sql = [
        call.args[0] for call in database.cursor.execute.call_args_list
        if not call.args[0].startswith("SET LOCAL")
    ]
    assert business_sql == [selected_sql]
    database.apply_migrations.assert_not_called()


@pytest.mark.parametrize("selection", ["", "  ", "q", "Q"])
def test_cancel_selection_does_not_connect(database, monkeypatch, capsys, selection):
    monkeypatch.setattr("builtins.input", lambda _prompt: selection)
    assert run_sql.main([]) == 0
    database.connect.assert_not_called()
    assert "已取消" in capsys.readouterr().out


@pytest.mark.parametrize("error_type", [EOFError, KeyboardInterrupt])
def test_unavailable_or_interrupted_input_gives_file_option_without_connecting(
    database, monkeypatch, capsys, error_type,
):
    monkeypatch.setattr("builtins.input", MagicMock(side_effect=error_type))
    assert run_sql.main([]) == 1
    database.connect.assert_not_called()
    assert "--file" in capsys.readouterr().err


@pytest.mark.parametrize("selection", ["0", "2"])
def test_out_of_range_selection_does_not_connect(database, monkeypatch, tmp_path, capsys, selection):
    (tmp_path / "only.sql").write_text("SELECT 1;", encoding="utf-8")
    monkeypatch.setattr(run_sql.migrate, "MIGRATIONS_DIRECTORY", tmp_path)
    monkeypatch.setattr("builtins.input", lambda _prompt: selection)
    assert run_sql.main([]) == 1
    database.connect.assert_not_called()
    assert "序号无效" in capsys.readouterr().err


@pytest.mark.parametrize("environment_override", [False, True])
def test_env_file_is_anchored_and_existing_environment_wins(
    database, monkeypatch, tmp_path, environment_override,
):
    (tmp_path / ".env").write_text(
        "MANJILU_DATABASE_URL=postgresql://env-file/database\n", encoding="utf-8",
    )
    other_directory = tmp_path / "working-directory"
    other_directory.mkdir()
    monkeypatch.chdir(other_directory)
    if not environment_override:
        monkeypatch.delenv("MANJILU_DATABASE_URL")
    assert run_sql.main(["--file", "memory/0004_user_profiles.sql"]) == 0
    expected = "postgresql://fixture/database" if environment_override else "postgresql://env-file/database"
    database.connect.assert_called_once_with(expected, autocommit=True, connect_timeout=10)


@pytest.mark.parametrize("source", [None, "SELECT 1; COMMIT; SELECT 2;"])
def test_missing_file_or_internal_commit_is_rejected_before_connect(
    database, tmp_path, source, capsys,
):
    path = tmp_path / "input.sql"
    if source is not None:
        path.write_text(source, encoding="utf-8")
    assert run_sql.main(["--file", str(path)]) == 1
    database.connect.assert_not_called()
    assert ("无法读取" if source is None else "SQL 文件检查失败") in capsys.readouterr().err


def test_existing_ledger_blocks_single_numbered_file(database, capsys):
    database.installed.return_value = []
    assert run_sql.main(["--file", "memory/0004_user_profiles.sql"]) == 1
    assert "已有迁移记录" in capsys.readouterr().err
    assert all(call.args[0].startswith("SET LOCAL") for call in database.cursor.execute.call_args_list)
    database.apply_migrations.assert_not_called()


@pytest.mark.parametrize("command", ["init", "migrate", "check"])
@pytest.mark.parametrize("extra", [["--file", "memory/0004_user_profiles.sql"], ["--dry-run"]])
def test_file_options_are_rejected_with_migration_commands(database, command, extra):
    with pytest.raises(SystemExit) as error:
        run_sql.main([command, *extra])
    assert error.value.code == 2
    database.connect.assert_not_called()


@pytest.mark.parametrize("command", ["init", "migrate", "check"])
def test_explicit_migration_command_preserves_exit_code(database, monkeypatch, command):
    delegate = MagicMock(return_value=7)
    monkeypatch.setattr(run_sql.migrate, "main", delegate)
    assert run_sql.main([command]) == 7
    delegate.assert_called_once_with([command])
    database.connect.assert_not_called()


@pytest.mark.parametrize("error_type", [psycopg.errors.SyntaxError, psycopg.errors.DuplicateTable])
def test_sql_failure_reaches_transaction_exit_and_hides_error_details(database, capsys, error_type):
    error = error_type("private-database-password")

    def execute(source, **kwargs):
        if "CREATE TABLE user_profiles" in source:
            raise error

    database.cursor.execute.side_effect = execute
    assert run_sql.main(["--file", "memory/0004_user_profiles.sql"]) == 1
    transaction_exit = database.connection.transaction.return_value.__exit__
    assert transaction_exit.call_args.args[:2] == (error_type, error)
    output = capsys.readouterr()
    assert "执行失败" in output.err
    assert "private-database-password" not in output.err
    assert "执行成功" not in output.out


def test_commit_failure_never_reports_success(database, capsys):
    database.connection.transaction.return_value.__exit__.side_effect = psycopg.OperationalError(
        "private-database-password",
    )
    assert run_sql.main(["--file", "memory/0004_user_profiles.sql"]) == 1
    output = capsys.readouterr()
    assert "执行失败" in output.err
    assert "private-database-password" not in output.err
    assert "执行成功" not in output.out


@pytest.mark.parametrize("command", ["init", "check"])
def test_database_override_keeps_connection_settings_and_env(database, monkeypatch, command):
    delegate = MagicMock(return_value=0)
    monkeypatch.setattr(run_sql.migrate, "main", delegate)
    assert run_sql.main([command, "--database", "manji_v2"]) == 0
    assert delegate.call_args.args == ([command],)
    connection_info = conninfo_to_dict(delegate.call_args.kwargs["database_url"])
    assert connection_info["host"] == "fixture"
    assert connection_info["dbname"] == "manji_v2"
    assert run_sql.os.environ["MANJILU_DATABASE_URL"] == "postgresql://fixture/database"


def test_file_database_override_and_bare_name_resolve_module(database):
    assert run_sql.main(["--file", "0004_user_profiles.sql", "--database", "manji_v2"]) == 0
    connection_info = conninfo_to_dict(database.connect.call_args.args[0])
    assert connection_info["dbname"] == "manji_v2"
    assert connection_info["host"] == "fixture"


def test_interactive_selection_lists_modules_in_dependency_order(database, monkeypatch, capsys):
    monkeypatch.setattr("builtins.input", lambda _prompt: "4")
    assert run_sql.main([]) == 0
    output = capsys.readouterr().out
    assert "1. account/0001_users.sql" in output
    assert "4. memory/0004_user_profiles.sql" in output
    assert "7. content/0007_story.sql" in output
    assert "CREATE TABLE user_profiles" in database.cursor.execute.call_args.args[0]


def test_ambiguous_bare_filename_does_not_connect(database, monkeypatch, tmp_path, capsys):
    for module in ("one", "two"):
        directory = tmp_path / module
        directory.mkdir()
        (directory / "0001_same.sql").write_text("CREATE TABLE example(id BIGINT);", encoding="utf-8")
    monkeypatch.setattr(run_sql.migrate, "MIGRATIONS_DIRECTORY", tmp_path)
    assert run_sql.main(["--file", "0001_same.sql"]) == 1
    database.connect.assert_not_called()
    assert "文件名不唯一" in capsys.readouterr().err

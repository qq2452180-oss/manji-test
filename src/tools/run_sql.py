"""在 PyCharm 中直接运行本文件，按提示选择要执行的 SQL 文件。

默认读取 src/.env；PyCharm 或终端已设置的环境变量优先。
单文件模式适用于手动建表的数据库，不补写结构初始化记录。
整个 SQL 文件在同一事务中执行；失败会回滚，已建表的 SQL 不要重复执行。

命令行示例（在项目根目录下）：
    python src/tools/run_sql.py
    python src/tools/run_sql.py --file memory/0004_user_profiles.sql
    python src/tools/run_sql.py --dry-run
    python src/tools/run_sql.py init --database manji_v2
    python src/tools/run_sql.py check --database manji_v2

--file 的相对路径以 src/common/schema 为基准，也支持绝对路径。
不传 --file 时列出该目录中的 SQL，可输入序号、文件名或路径；直接回车取消。
--dry-run 执行后回滚事务，用于验证建表 SQL；默认运行会提交。
init 初始化新库，migrate 在已登记库中按编号追加升级，check 只读检查。
--database 只替换本次连接的数据库名，不修改 .env；数据库需要事先创建。
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys


SRC_DIR = Path(__file__).resolve().parents[1]

# PyCharm 的“运行文件”和终端的绝对路径运行都不依赖当前工作目录。
if __package__ in (None, ""):
    sys.path.insert(0, str(SRC_DIR.parent))

from dotenv import load_dotenv
import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from src.common import migrate


def select_sql_file() -> Path | None:
    """运行时选择单个 SQL 文件，不默认执行任何建表语句。"""
    directory = migrate.MIGRATIONS_DIRECTORY
    paths = sorted(
        (path for path in directory.rglob("*.sql") if path.is_file()), key=lambda path: path.name,
    )
    print(f"可执行的 SQL 文件（{directory}）：")
    for index, path in enumerate(paths, start=1):
        print(f"  {index}. {path.relative_to(directory)}")
    if not paths:
        print("  该目录中没有 SQL 文件，请输入文件路径。")
    try:
        selection = input("请输入序号、SQL 文件名或路径（回车或 q 取消）：").strip()
    except (EOFError, KeyboardInterrupt):
        raise ValueError("未读取到选择；请重新运行，或使用 --file 指定 SQL 文件。") from None
    if not selection or selection.lower() == "q":
        return None
    if selection.isdecimal():
        index = int(selection)
        if not 1 <= index <= len(paths):
            raise ValueError("序号无效，请选择列表中的序号，或使用 --file 指定 SQL 文件。")
        return paths[index - 1]
    return resolve_sql_path(Path(selection))


def resolve_sql_path(path: Path) -> Path:
    """接受模块相对路径，也允许唯一的建表文件名。"""
    path = path.expanduser()
    if path.is_absolute():
        return path
    directory = migrate.MIGRATIONS_DIRECTORY
    direct = directory / path
    if direct.exists() or len(path.parts) > 1:
        return direct
    matches = [candidate for candidate in directory.rglob(path.name) if candidate.is_file()]
    if len(matches) > 1:
        raise ValueError("SQL 文件名不唯一，请指定包含模块目录的相对路径。")
    return matches[0] if matches else direct


def execute_file(path: Path, *, dry_run: bool = False, database_url: str | None = None) -> int:
    """执行单个文件；不把现有业务表冒充为已经执行过的迁移。"""
    try:
        source = migrate._transaction_body(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        print(f"无法读取 SQL 文件，请检查路径和 UTF-8 编码：{path}", file=sys.stderr)
        return 1
    except migrate.MigrationError as error:
        print(f"SQL 文件检查失败：{error}", file=sys.stderr)
        return 1

    database_url = (os.getenv("MANJILU_DATABASE_URL", "") if database_url is None else database_url).strip()
    if not database_url:
        print("请在 src/.env 或运行环境中配置 MANJILU_DATABASE_URL。", file=sys.stderr)
        return 1

    try:
        with psycopg.connect(database_url, autocommit=True, connect_timeout=10) as connection:
            with connection.transaction(force_rollback=dry_run), connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute("SET LOCAL lock_timeout = '5s'")
                cursor.execute("SET LOCAL statement_timeout = '30s'")
                if path.is_relative_to(migrate.MIGRATIONS_DIRECTORY.resolve()) and migrate._installed(cursor) is not None:
                    print("该数据库已有迁移记录，请使用 migrate 命令执行编号 SQL。", file=sys.stderr)
                    return 1
                cursor.execute(source, prepare=False)
        if dry_run:
            print(f"验证通过，事务已回滚：{path.name}")
        else:
            print(f"执行成功，事务已提交：{path.name}")
        return 0
    except psycopg.errors.DuplicateTable:
        print("执行失败：目标表已存在；本次事务已回滚，请勿重复执行建表文件。", file=sys.stderr)
    except psycopg.Error as error:
        # 异常全文可能包含连接凭据或 SQL 中的数据，只输出错误类别和代码。
        print(
            f"执行失败：{type(error).__name__}（SQLSTATE: {error.sqlstate or '无'}）；"
            "请检查数据库连接、权限和 SQL，未成功提交的事务将回滚。",
            file=sys.stderr,
        )
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "command", nargs="?", choices=("execute", "init", "migrate", "check"), default="execute",
        help="execute：执行指定文件（默认）；init：初始化新库；check：校验结构",
    )
    parser.add_argument("--file", type=Path, help="待执行 SQL 文件；不传时在控制台选择")
    parser.add_argument("--dry-run", action="store_true", help="单文件执行后回滚事务，用于验证建表 SQL")
    parser.add_argument("--database", help="本次连接的数据库名，沿用配置中的主机和账号，不修改 .env")
    args = parser.parse_args(argv)
    if args.command != "execute" and (args.file is not None or args.dry_run):
        parser.error("--file 和 --dry-run 只能用于 execute 模式")
    load_dotenv(SRC_DIR / ".env", override=False)
    connection_options = {}
    if args.database is not None:
        database_url = os.getenv("MANJILU_DATABASE_URL", "").strip()
        if not database_url or not args.database.strip():
            print("请配置 MANJILU_DATABASE_URL，并指定非空数据库名。", file=sys.stderr)
            return 1
        try:
            connection_options["database_url"] = make_conninfo(database_url, dbname=args.database.strip())
        except psycopg.ProgrammingError:
            print("MANJILU_DATABASE_URL 格式无效，请检查连接配置。", file=sys.stderr)
            return 1
    if args.command != "execute":
        return migrate.main([args.command], **connection_options)
    try:
        path = args.file if args.file is not None else select_sql_file()
        if path is not None:
            path = resolve_sql_path(path)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    if path is None:
        print("已取消，未执行 SQL。")
        return 0
    return execute_file(path.resolve(), dry_run=args.dry_run, **connection_options)


if __name__ == "__main__":
    raise SystemExit(main())

from pathlib import Path

import yaml

DATA_DIRECTORY = Path(__file__).resolve().parents[2] / "data"


def parse_volumes(source: str) -> list[dict]:
    source = source.strip()
    document = yaml.safe_load(source.removeprefix("```yaml").removesuffix("```"))
    if not isinstance(document, dict) or not isinstance(document.get("full_biography_by_decade"), dict):
        raise ValueError("话题 YAML 缺少 full_biography_by_decade")
    volumes = document["full_biography_by_decade"].get("decades")
    if not isinstance(volumes, list):
        raise ValueError("话题 YAML 的 decades 必须是列表")
    return volumes


def read_volumes(decade: int) -> list[dict]:
    if decade not in (50, 60, 70):
        raise ValueError("不支持的出生年代")
    return parse_volumes((DATA_DIRECTORY / f"{decade}.md").read_text(encoding="utf-8"))


def ensure_volumes(connection, decade: int) -> None:
    connection.execute("SELECT pg_advisory_xact_lock(10450, %s)", (decade,))
    if connection.execute("SELECT 1 FROM chapter WHERE birth_decade = %s LIMIT 1", (decade,)).fetchone():
        return
    with connection.cursor() as cursor:
        for index, volume in enumerate(read_volumes(decade), 1):
            chapter = cursor.execute(
                "INSERT INTO chapter (birth_decade, title, volume_title, sort_order) VALUES (%s, %s, %s, %s) RETURNING id",
                (decade, volume["decade"], volume["volume_title"], index),
            ).fetchone()
            topics = [(section["section"], topic["title"], topic["description"])
                      for section in volume["sections"] for topic in section["topics"]]
            cursor.executemany(
                "INSERT INTO topic (chapter_id, sort_order, section_title, title, description) VALUES (%s, %s, %s, %s, %s)",
                [(chapter["id"], order, *topic) for order, topic in enumerate(topics, 1)],
            )

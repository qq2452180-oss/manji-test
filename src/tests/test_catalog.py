"""公开目录、可选话题及排序和停用规则；数据库验证使用独立测试 schema。"""

from unittest.mock import MagicMock, Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from src.api.catalog.router import catalog_error, router
from src.service.catalog import CatalogError, CatalogRepository, CatalogService
from src.tests.test_guest_auth import guest_database  # noqa: F401


@pytest.fixture
def repository(monkeypatch):
    repository = CatalogRepository("unused")
    connection = MagicMock()
    connection.__enter__.return_value = connection
    monkeypatch.setattr(repository, "_connect", lambda: connection)
    return repository, connection


def test_repository_groups_topics_and_preserves_empty_chapters(repository):
    store, connection = repository
    connection.execute.return_value.fetchall.return_value = [
        {"chapter_id": 3, "chapter_title": "早年生活", "chapter_sort_order": 1,
         "topic_id": 8, "topic_title": "住过的地方", "topic_description": "聊聊住处。",
         "topic_sort_order": 2},
        {"chapter_id": 3, "chapter_title": "早年生活", "chapter_sort_order": 1,
         "topic_id": 9, "topic_title": "熟悉的路", "topic_description": "聊聊路途。",
         "topic_sort_order": 2},
        {"chapter_id": 5, "chapter_title": "现在的生活", "chapter_sort_order": 3,
         "topic_id": None, "topic_title": None, "topic_description": None,
         "topic_sort_order": None},
    ]

    assert CatalogService(store).list_catalog() == {"chapters": [
        {"id": 3, "title": "早年生活", "sort_order": 1, "topics": [
            {"id": 8, "chapter_id": 3, "title": "住过的地方", "description": "聊聊住处。", "sort_order": 2},
            {"id": 9, "chapter_id": 3, "title": "熟悉的路", "description": "聊聊路途。", "sort_order": 2},
        ]},
        {"id": 5, "title": "现在的生活", "sort_order": 3, "topics": []},
    ]}


def test_empty_catalog_returns_empty_chapters(repository):
    store, connection = repository
    connection.execute.return_value.fetchall.return_value = []

    assert CatalogService(store).list_catalog() == {"chapters": []}


@pytest.mark.parametrize("topic", [
    None, {"id": 8, "chapter_id": 3, "chapter_title": "早年生活", "title": "住过的地方", "description": "聊聊住处。"},
])
def test_topic_lookup_returns_saved_topic_or_none(repository, topic):
    store, connection = repository
    connection.execute.return_value.fetchone.return_value = topic

    assert CatalogService(store).get_enabled_topic(8) == topic
    assert connection.execute.call_args.args[1] == (8,)


def test_catalog_route_is_public():
    app = FastAPI()
    service = Mock(spec=CatalogService)
    service.list_catalog.return_value = {"chapters": []}
    app.state.catalog = service
    app.include_router(router)

    with TestClient(app) as client:
        response = client.get("/api/catalog")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"chapters": []}
    service.list_catalog.assert_called_once_with()


def test_catalog_database_failure_returns_public_error_without_database_details():
    app = FastAPI()
    repository = Mock(spec=CatalogRepository)
    repository.list_catalog.side_effect = psycopg.OperationalError("private database details")
    app.state.catalog = CatalogService(repository)
    app.include_router(router)
    app.add_exception_handler(CatalogError, catalog_error)

    with TestClient(app) as client:
        response = client.get("/api/catalog")

    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"detail": "话题目录暂时无法读取，请稍后重试"}


def test_topic_database_failure_uses_catalog_error():
    repository = Mock(spec=CatalogRepository)
    repository.get_enabled_topic.side_effect = psycopg.OperationalError("private database details")

    with pytest.raises(CatalogError) as error:
        CatalogService(repository).get_enabled_topic(8)

    assert error.value.status_code == 503
    assert str(error.value) == "话题目录暂时无法读取，请稍后重试"


def test_postgres_catalog_orders_and_filters_chapters_and_topics(guest_database):
    with psycopg.connect(guest_database) as connection:
        connection.execute("UPDATE chapter SET is_enabled = FALSE")
        chapters = connection.execute(
            "INSERT INTO chapter (title, sort_order, is_enabled) VALUES "
            "('排后', 3, TRUE), ('同序前', 1, TRUE), ('同序后', 1, TRUE), "
            "('空章节', 4, TRUE), ('停用章节', 0, FALSE) RETURNING id"
        ).fetchall()
        later, first, second, empty, disabled = [row[0] for row in chapters]
        topics = []
        for chapter_id, title, sort_order, enabled in (
            (first, "次序后", 2, True), (first, "同序前", 1, True),
            (first, "同序后", 1, True), (first, "停用话题", 0, False),
            (disabled, "停用章节下的话题", 0, True), (later, "另一章节的话题", 0, True),
        ):
            topics.append(connection.execute(
                "INSERT INTO topic (chapter_id, title, description, sort_order, is_enabled) "
                "VALUES (%s, %s, %s, %s, %s) RETURNING id",
                (chapter_id, title, "话题描述", sort_order, enabled),
            ).fetchone()[0])

    service = CatalogService(CatalogRepository(guest_database))
    catalog = service.list_catalog()["chapters"]
    assert [chapter["id"] for chapter in catalog] == [first, second, later, empty]
    assert [topic["id"] for topic in catalog[0]["topics"]] == [topics[1], topics[2], topics[0]]
    assert catalog[1]["topics"] == catalog[3]["topics"] == []
    assert [topic["id"] for topic in catalog[2]["topics"]] == [topics[5]]
    assert service.get_enabled_topic(topics[1]) == {
        "id": topics[1], "chapter_id": first, "chapter_title": "同序前", "title": "同序前", "description": "话题描述",
    }
    assert service.get_enabled_topic(topics[3]) is None
    assert service.get_enabled_topic(topics[4]) is None
    assert service.get_enabled_topic(max(topics) + 1) is None

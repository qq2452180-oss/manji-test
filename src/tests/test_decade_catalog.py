from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import Mock

from fastapi.testclient import TestClient
import psycopg
import pytest

from src.service.catalog import CatalogError
from src.service.catalog.templates import read_volumes
from src.tests.test_guest_auth import guest_database
from src.tests.test_home import home_app, new_user


@pytest.mark.parametrize("decade, volumes, topics", [(50, 7, 116), (60, 7, 145), (70, 6, 123)])
def test_complete_templates(decade, volumes, topics):
    outline = read_volumes(decade)
    assert len(outline) == volumes
    entries = [topic for volume in outline for section in volume["sections"] for topic in section["topics"]]
    assert len(entries) == topics
    assert all(topic["title"].strip() and topic["description"].strip() for topic in entries)


def test_member_selection_is_private_scoped_locked_and_reuses_ids(home_app, monkeypatch):
    model = Mock(side_effect=AssertionError("已固定模板不可触发职业生成"))
    monkeypatch.setattr("src.service.catalog.service.generate_occupation_topics", model)
    path = "/api/catalog/mine"
    with TestClient(home_app) as client:
        assert client.get(path).status_code == 401
        assert client.put(path, json={"birth_decade": 60}).status_code == 401
        _, first = new_user(client)
        _, second = new_user(client)
        empty = {"birth_decade": None, "occupation": None, "chapters": []}
        assert client.get(path, headers=first).json() == empty
        assert client.post("/api/interviews", headers=first, json={"topic_id": 1}).status_code == 422
        assert client.put(path, headers=first, json={"birth_decade": 80}).status_code == 422
        selected = client.put(path, headers=first, json={"birth_decade": 60})
        assert selected.status_code == 200
        assert selected.headers["cache-control"] == "private, no-store"
        catalog = selected.json()
        assert catalog["birth_decade"] == 60
        assert sum(len(chapter["topics"]) for chapter in catalog["chapters"]) == 145
        chapter = catalog["chapters"][0]
        assert chapter["title"] == "六十年代卷"
        assert chapter["topics"][0]["section_title"] == "第一节 出生与家族起点"
        assert client.get(path, headers=first).json() == catalog
        assert client.get(path, headers=second).json() == empty
        topic_id = chapter["topics"][0]["id"]
        assert client.post("/api/interviews", headers=second, json={"topic_id": topic_id}).status_code == 422
        for selection in ({"birth_decade": 50}, {"birth_decade": 60, "occupation": "教师"}):
            rejected = client.put(path, headers=first, json=selection)
            assert rejected.status_code == 409
            assert rejected.json() == {"detail": "出生年代和职业已确认，不能修改模板。"}
            assert "no-store" in rejected.headers["cache-control"]
            assert client.get(path, headers=first).json() == catalog
        assert client.put(path, headers=first, json={"birth_decade": 60}).json() == catalog
        assert client.put(path, headers=second, json={"birth_decade": 60}).json() == catalog
        model.assert_not_called()


@pytest.mark.parametrize("selections", [
    [(50, None), (60, None)],
    [(60, None), (60, "教师")],
    [(60, "教师"), (60, "工人")],
])
def test_concurrent_first_selections_only_commit_one_combination(home_app, guest_database, selections):
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        barrier = Barrier(2)

        def select(selection):
            barrier.wait(timeout=3)
            try:
                return home_app.state.catalog.member_catalog(owner, *selection)
            except CatalogError as exc:
                assert exc.status_code == 409
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(select, selections))
        saved, = [result for result in results if result is not None]
        assert client.get("/api/catalog/mine", headers=headers).json() == saved
        assert home_app.state.catalog.member_catalog(owner, saved["birth_decade"], saved["occupation"]) == saved
        with psycopg.connect(guest_database) as connection:
            imported = connection.execute(
                "SELECT DISTINCT birth_decade FROM chapter WHERE birth_decade IN (50, 60)"
            ).fetchall()
        assert imported == [(saved["birth_decade"],)]


def test_concurrent_identical_first_selections_reuse_the_same_topics(home_app):
    with TestClient(home_app) as client:
        owner, _ = new_user(client)
        barrier = Barrier(2)

        def select(_):
            barrier.wait(timeout=3)
            return home_app.state.catalog.select_catalog(owner, 60)

        with ThreadPoolExecutor(max_workers=2) as executor:
            first, repeated = executor.map(select, range(2))
        assert first == repeated
        assert sum(len(chapter["topics"]) for chapter in first["chapters"]) == 145

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Event
from time import monotonic
from unittest.mock import Mock

from fastapi.testclient import TestClient
import pytest
import yaml

from src.service.catalog import CatalogError
from src.service.catalog.occupation_topics import parse_occupation_topics
from src.service.catalog.templates import read_volumes
from src.tests.test_guest_auth import guest_database
from src.tests.test_home import home_app, new_user


MODEL_YAML = """full_biography_by_decade:
  decades:
    - decade: 八十年代卷
      sections:
        - section: 第一节 教育热、文凭热与职业起步
          topics:
            - title: 第一次独自备课
              description: 刚开始教书时，您是怎么准备一堂课的？
    - decade: 九十年代卷
      sections:
        - section: 第一节 市场经济下的职业震荡
          topics:
            - title: 课堂上的新办法
              description: 教书过程中，您有没有尝试过新的讲课办法？
"""


def expanded_model_document():
    document = yaml.safe_load(MODEL_YAML)
    extra_topics = [
        [
            ("备课时的讨论", "备课时，您和同事有过什么难忘的讨论？"),
            ("制作教具的经历", "您有没有亲手制作过让学生更容易理解的教具？"),
            ("公开课的准备", "您有没有为一堂公开课做过特别的准备？"),
        ],
        [
            ("与家长的一次交流", "有没有哪次和学生家长的交流让您印象深刻？"),
            ("批改作业时的发现", "批改作业时，您有没有发现过学生意料之外的想法？"),
            ("和同事一起解决难题", "有没有哪次教学难题，是您和同事一起解决的？"),
        ],
    ]
    for volume, additions in zip(document["full_biography_by_decade"]["decades"], extra_topics):
        volume["sections"][0]["topics"].extend(
            {"title": title, "description": description} for title, description in additions
        )
    return document


def wait_for_catalog(client, headers, status):
    deadline = monotonic() + 5
    while monotonic() < deadline:
        response = client.get("/api/catalog/mine", headers=headers)
        assert response.status_code == 200, response.text
        catalog = response.json()
        if catalog.get("occupation_status") == status:
            return catalog
        Event().wait(0.01)
    pytest.fail(f"职业补题未进入 {status} 状态：{catalog}")


@pytest.fixture
def chapters():
    return [
        {"id": index, "title": volume["decade"], "topics": [
            {**topic, "section_title": section["section"]}
            for section in volume["sections"] for topic in section["topics"]
        ]}
        for index, volume in enumerate(read_volumes(60), 1)
    ]


@pytest.mark.parametrize("fenced", [False, True])
def test_parse_matches_existing_chapters_and_sections_without_changing_catalog(chapters, fenced):
    original = deepcopy(chapters)
    source = "\n```yaml\n" + MODEL_YAML + "```\n" if fenced else MODEL_YAML
    assert parse_occupation_topics(source, chapters) == [
        {"chapter_id": 3, "section_title": "第一节 教育热、文凭热与职业起步",
         "title": "第一次独自备课", "description": "刚开始教书时，您是怎么准备一堂课的？"},
        {"chapter_id": 4, "section_title": "第一节 市场经济下的职业震荡",
         "title": "课堂上的新办法", "description": "教书过程中，您有没有尝试过新的讲课办法？"},
    ]
    assert chapters == original


@pytest.mark.parametrize("source, message", [
    ("", "full_biography_by_decade"),
    ("full_biography_by_decade: {}", "decades"),
    (MODEL_YAML.replace("八十年代卷", "不存在的卷"), "不存在卷"),
    (MODEL_YAML.replace("第一节 教育热、文凭热与职业起步", "第一节 市场经济下的职业震荡"), "不存在小节"),
    (MODEL_YAML.replace("第一次独自备课", '"   "'), "title"),
    (MODEL_YAML.replace("刚开始教书时，您是怎么准备一堂课的？", "null"), "description"),
    (MODEL_YAML.replace("topics:", "topics: null\n          invalid:"), "topics"),
])
def test_invalid_output_is_rejected(chapters, source, message):
    with pytest.raises(ValueError, match=message):
        parse_occupation_topics(source, chapters)


def test_parse_rejects_invalid_yaml(chapters):
    with pytest.raises(yaml.YAMLError):
        parse_occupation_topics("full_biography_by_decade: [", chapters)


def test_parse_empty_and_duplicate_additions(chapters):
    assert parse_occupation_topics("full_biography_by_decade:\n  decades: []", chapters) == []
    document = yaml.safe_load(MODEL_YAML)
    topics = document["full_biography_by_decade"]["decades"][0]["sections"][0]["topics"]
    topics.append({"title": " 第一次独自备课 ", "description": "刚开始教书时，您是怎么准备一堂课的？"})
    original_topic = chapters[2]["topics"][0]
    topics.append({key: original_topic[key] for key in ("title", "description")})
    source = yaml.safe_dump(document, allow_unicode=True)
    assert len(parse_occupation_topics(source, chapters)) == 2


def test_parse_accepts_more_than_five_distinct_new_topics(chapters):
    original = deepcopy(chapters)
    document = expanded_model_document()
    additions = parse_occupation_topics(yaml.safe_dump(document, allow_unicode=True), chapters)
    expected = [
        {"chapter_id": index + 3, "section_title": section["section"], **topic}
        for index, volume in enumerate(document["full_biography_by_decade"]["decades"])
        for section in volume["sections"] for topic in section["topics"]
    ]
    assert len(additions) == 8
    assert additions == expected
    assert chapters == original


def test_large_batch_deduplicates_within_batch_across_volumes_and_existing_catalog(chapters):
    document = expanded_model_document()
    expected = parse_occupation_topics(yaml.safe_dump(document, allow_unicode=True), chapters)
    first, second = document["full_biography_by_decade"]["decades"]
    repeated = first["sections"][0]["topics"][0]
    first["sections"][0]["topics"].append({key: f" {value} " for key, value in repeated.items()})
    second["sections"][0]["topics"].append(deepcopy(repeated))
    existing = chapters[0]["topics"][0]
    second["sections"][0]["topics"].append({key: existing[key] for key in ("title", "description")})
    assert parse_occupation_topics(yaml.safe_dump(document, allow_unicode=True), chapters) == expected
    assert len(expected) == 8


def test_append_persists_private_topics_preserves_originals_and_supports_retries(home_app, monkeypatch):
    monkeypatch.setattr("src.langgraph.node.interview.call_qwen", lambda *_args, **_kwargs: "您还记得第一次备课吗？")
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        other, other_headers = new_user(client)
        unselected, _ = new_user(client)
        service = home_app.state.catalog
        with pytest.raises(ValueError, match="先选择出生年代"):
            service.append_occupation_topics(unselected, MODEL_YAML)
        before = client.put("/api/catalog/mine", headers=headers, json={"birth_decade": 60}).json()
        assert client.put("/api/catalog/mine", headers=other_headers, json={"birth_decade": 60}).json() == before
        public_before = service.list_catalog()
        invalid = MODEL_YAML.replace("第一节 市场经济下的职业震荡", "不存在的小节")
        with pytest.raises(ValueError, match="不存在小节"):
            service.append_occupation_topics(owner, invalid)
        assert service.member_catalog(owner) == before

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: service.append_occupation_topics(owner, MODEL_YAML), range(2)))
        after = results[0]
        assert results[1] == after
        assert service.append_occupation_topics(owner, MODEL_YAML) == after
        assert service.append_occupation_topics(owner, "full_biography_by_decade:\n  decades: []") == after
        assert client.get("/api/catalog/mine", headers=headers).json() == after
        assert client.get("/api/catalog/mine", headers=other_headers).json() == before
        assert service.list_catalog() == public_before

        additions = []
        for original, updated in zip(before["chapters"], after["chapters"]):
            assert updated["topics"][:len(original["topics"])] == original["topics"]
            new_topics = updated["topics"][len(original["topics"]):]
            additions.extend(new_topics)
            for topic in new_topics:
                assert topic["chapter_id"] == original["id"]
                assert topic["section_title"] == original["topics"][0]["section_title"]
                assert topic["sort_order"] > max(item["sort_order"] for item in original["topics"])
                assert service.get_enabled_topic(topic["id"], user_id=owner)["title"] == topic["title"]
                assert service.get_enabled_topic(topic["id"], user_id=other) is None
                assert client.post("/api/interviews", headers=other_headers,
                                   json={"topic_id": topic["id"]}).status_code == 422
        assert [topic["title"] for topic in additions] == ["第一次独自备课", "课堂上的新办法"]
        started = client.post("/api/interviews", headers=headers, json={"topic_id": additions[0]["id"]})
        assert started.status_code == 201, started.text
        assert started.json()["selected_topic"]["id"] == additions[0]["id"]
        with pytest.raises(CatalogError) as rejected:
            service.member_catalog(owner, 50)
        assert rejected.value.status_code == 409
        assert service.get_enabled_topic(additions[0]["id"], user_id=owner)["id"] == additions[0]["id"]
        assert service.member_catalog(owner, 60) == after


@pytest.mark.parametrize("addition_count", [2, 8], ids=["small-batch", "more-than-five"])
def test_selection_generates_from_existing_catalog_and_reuses_saved_results(home_app, monkeypatch, addition_count):
    started, release = Event(), Event()
    source = MODEL_YAML if addition_count == 2 else yaml.safe_dump(expanded_model_document(), allow_unicode=True)

    def generate(*_args, **_kwargs):
        started.set()
        assert release.wait(5)
        return source

    model = Mock(side_effect=generate)
    monkeypatch.setattr("src.service.catalog.occupation_topics.call_qwen_thinking", model)
    with TestClient(home_app) as client:
        owner, headers = new_user(client)
        _, other_headers = new_user(client)
        path = "/api/catalog/mine"
        before = client.put(path, headers=other_headers, json={"birth_decade": 60}).json()
        model.assert_not_called()
        for invalid in ("", "   ", "职" * 51, 42):
            assert client.put(path, headers=headers, json={"birth_decade": 60, "occupation": invalid}).status_code == 422
        selection = {"birth_decade": 60, "occupation": "教师"}
        try:
            response = client.put(path, headers=headers, json=selection)
            assert response.status_code == 200
            initial = response.json()
            assert initial["occupation"] == "教师"
            assert initial["occupation_status"] == "generating"
            assert sum(len(chapter["topics"]) for chapter in initial["chapters"]) == 145
            assert started.wait(1)
            assert client.get(path, headers=headers).json() == initial
            assert client.put(path, headers=headers, json=selection).json() == initial
            assert model.call_count == 1
        finally:
            release.set()
        catalog = wait_for_catalog(client, headers, "completed")
        assert sum(len(chapter["topics"]) for chapter in catalog["chapters"]) == 145 + addition_count
        assert model.call_count == 1
        messages = model.call_args.args[0]
        assert messages[0][0] == "system"
        assert "追加清单" in messages[0][1]
        supplied = yaml.safe_load(messages[1][1])
        assert supplied["birth_decade"] == 60
        assert supplied["occupation"] == "教师"
        volumes = supplied["full_biography_by_decade"]["decades"]
        assert sum(len(section["topics"]) for volume in volumes for section in volume["sections"]) == 145
        assert volumes[2]["decade"] == "八十年代卷"
        assert volumes[2]["sections"][0]["section"] == "第一节 教育热、文凭热与职业起步"
        assert client.get(path, headers=headers).json() == catalog
        assert client.put(path, headers=headers, json=selection).json() == catalog
        assert model.call_count == 1
        assert client.put(path, headers=other_headers, json={"birth_decade": 60}).json() == before

        for changed in (
            {"birth_decade": 60, "occupation": "工人"},
            {"birth_decade": 50, "occupation": "教师"},
            {"birth_decade": 60, "occupation": None},
            {"birth_decade": 60},
        ):
            rejected = client.put(path, headers=headers, json=changed)
            assert rejected.status_code == 409
            assert "不能修改模板" in rejected.json()["detail"]
            assert client.get(path, headers=headers).json() == catalog
        assert client.put(path, headers=headers, json=selection).json() == catalog
        assert model.call_count == 1


@pytest.mark.parametrize("failure", [TimeoutError("private model details"), "invalid: [", MODEL_YAML.replace("九十年代卷", "未知卷")])
def test_generation_failure_keeps_base_topics_and_can_retry(home_app, monkeypatch, failure):
    model = Mock(side_effect=failure) if isinstance(failure, Exception) else Mock(return_value=failure)
    monkeypatch.setattr("src.service.catalog.occupation_topics.call_qwen_thinking", model)
    with TestClient(home_app) as client:
        _, headers = new_user(client)
        selection = {"birth_decade": 60, "occupation": "教师"}
        response = client.put("/api/catalog/mine", headers=headers, json=selection)
        assert response.status_code == 200
        assert response.json()["occupation_status"] == "generating"
        result = wait_for_catalog(client, headers, "failed")
        assert "稍后重试" in result["occupation_error"]
        assert "private model details" not in str(result)
        assert result["occupation"] == "教师"
        assert sum(len(chapter["topics"]) for chapter in result["chapters"]) == 145
        saved = client.get("/api/catalog/mine", headers=headers).json()
        assert saved["chapters"] == result["chapters"]
        assert saved["occupation"] == "教师"
        model.side_effect = None
        model.return_value = yaml.safe_dump(expanded_model_document(), allow_unicode=True)
        retried = client.put("/api/catalog/mine", headers=headers, json=selection).json()
        assert "occupation_error" not in retried
        retried = wait_for_catalog(client, headers, "completed")
        assert sum(len(chapter["topics"]) for chapter in retried["chapters"]) == 153
        assert model.call_count == 2
        assert client.put("/api/catalog/mine", headers=headers, json=selection).json() == retried
        assert client.get("/api/catalog/mine", headers=headers).json() == retried
        assert model.call_count == 2


def test_generation_is_serialized_and_selection_stays_locked_while_generating(home_app, monkeypatch):
    started, release = Event(), Event()

    def generate(*_args, **_kwargs):
        started.set()
        assert release.wait(5)
        return MODEL_YAML

    model = Mock(side_effect=generate)
    monkeypatch.setattr("src.service.catalog.occupation_topics.call_qwen_thinking", model)
    with TestClient(home_app) as client:
        owner, _ = new_user(client)
        service = home_app.state.catalog
        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(lambda _: service.select_catalog(owner, 60, "教师"), range(2)))
                assert started.wait(1)
                assert results[0] == results[1]
                assert results[0]["occupation_status"] == "generating"
                assert model.call_count == 1
                with pytest.raises(CatalogError) as rejected:
                    executor.submit(service.select_catalog, owner, 50).result(timeout=1)
                assert rejected.value.status_code == 409
            assert service.member_catalog(owner)["birth_decade"] == 60
        finally:
            release.set()
        service._jobs[(owner, 60, "教师")].result(timeout=5)
        completed = service.member_catalog(owner)
        assert completed["occupation_status"] == "completed"
        assert sum(len(chapter["topics"]) for chapter in completed["chapters"]) == 147
        assert service._repository.append_occupation_topics(
            owner, MODEL_YAML, birth_decade=60, occupation="教师",
        ) == completed
        assert service._repository.append_occupation_topics(
            owner, MODEL_YAML, birth_decade=50, occupation="教师",
        ) == completed
        assert model.call_count == 1

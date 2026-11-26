"""职业补题后台执行：模板先返回、任务去重、过期结果和独立超时。"""

from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from copy import deepcopy
import socket
from threading import Event, RLock
from time import monotonic
from types import SimpleNamespace
from unittest.mock import Mock

from langchain_core.messages import AIMessage
import pytest

from src.langgraph.llm import qwen
from src.service.catalog.occupation_topics import generate_occupation_topics, parse_occupation_topics
from src.service.catalog.repository import CatalogSelectionLocked
from src.service.catalog.service import CatalogError, CatalogService


BASE_CHAPTERS = [{
    "id": 1, "title": "八十年代卷", "volume_title": "职业起步",
    "topics": [{"id": 1, "chapter_id": 1, "section_title": "第一节 职业起步",
                "title": "第一份工作", "description": "您怎样找到第一份工作？", "sort_order": 1}],
}]
MODEL_YAML = """full_biography_by_decade:
  decades:
    - decade: 八十年代卷
      sections:
        - section: 第一节 职业起步
          topics:
            - title: 第一次备课
              description: 您还记得第一次备课的情景吗？
"""
EMPTY_YAML = "full_biography_by_decade:\n  decades: []"


class MemoryCatalogRepository:
    """只提供服务测试所需的选择、原子追加和已完成组合契约。"""

    def __init__(self):
        self.lock = RLock()
        self.selections = {}
        self.chapters = {}
        self.completed = set()

    def member_catalog(self, user_id, decade=None, occupation=None):
        with self.lock:
            if decade is not None:
                current = self.selections.get(user_id)
                if current is not None and current != (decade, occupation):
                    raise CatalogSelectionLocked("出生年代和职业确定后不可修改")
                self.selections[user_id] = (decade, occupation)
            birth_decade, selected = self.selections.get(user_id, (None, None))
            chapters = self.chapters.setdefault((user_id, birth_decade), deepcopy(BASE_CHAPTERS))
            result = {"birth_decade": birth_decade, "occupation": selected,
                      "chapters": deepcopy(chapters) if birth_decade else []}
            if selected:
                result["occupation_status"] = (
                    "completed" if (user_id, birth_decade, selected) in self.completed else "idle"
                )
            return result

    def append_occupation_topics(self, user_id, source, *, birth_decade=None, occupation=None):
        assert isinstance(source, str), "模型生成必须在 repository 事务外完成"
        with self.lock:
            key = (user_id, birth_decade, occupation)
            if self.selections[user_id] != (birth_decade, occupation) or key in self.completed:
                return self.member_catalog(user_id)
            chapters = self.chapters[(user_id, birth_decade)]
            for topic in parse_occupation_topics(source, chapters):
                chapter = next(item for item in chapters if item["id"] == topic["chapter_id"])
                chapter["topics"].append({**topic, "id": len(chapter["topics"]) + 1})
            self.completed.add(key)
            return self.member_catalog(user_id)


@pytest.fixture
def background(monkeypatch):
    forbidden = Mock(side_effect=AssertionError("后台补题测试不可访问网络"))
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    repository = MemoryCatalogRepository()
    service = CatalogService(repository)
    releases = []

    def gate():
        event = Event()
        releases.append(event)
        return event

    yield SimpleNamespace(repository=repository, service=service, gate=gate)
    for event in releases:
        event.set()
    service.close()
    for future in list(service._jobs.values()):
        try:
            future.exception(timeout=5)
        except CancelledError:
            pass


def wait_for_status(service, user_id, status):
    deadline = monotonic() + 3
    while monotonic() < deadline:
        catalog = service.member_catalog(user_id)
        if catalog.get("occupation_status") == status:
            return catalog
        Event().wait(0.005)
    pytest.fail(f"后台补题未进入 {status} 状态：{catalog}")


def test_selection_returns_template_while_generation_runs_and_reuses_one_job(background, monkeypatch):
    service = background.service
    started, release = Event(), background.gate()

    def generate(_catalog):
        started.set()
        assert release.wait(5)
        return MODEL_YAML

    model = Mock(side_effect=generate)
    monkeypatch.setattr("src.service.catalog.service.generate_occupation_topics", model)
    untouched = service.select_catalog(2, 60)
    assert "occupation_status" not in untouched
    model.assert_not_called()
    with ThreadPoolExecutor(max_workers=4) as requests:
        first = requests.submit(service.select_catalog, 1, 60, "教师")
        assert started.wait(1)
        initial = first.result(timeout=1)
        assert initial["chapters"] == BASE_CHAPTERS
        assert initial["occupation_status"] == "generating"
        repeated = list(requests.map(lambda _: service.select_catalog(1, 60, "教师"), range(4)))
        assert all(item == initial for item in repeated)
    assert service.member_catalog(1) == initial
    assert model.call_count == 1
    release.set()
    final = wait_for_status(service, 1, "completed")
    assert [item["title"] for item in final["chapters"][0]["topics"]] == ["第一份工作", "第一次备课"]
    assert service.select_catalog(1, 60, "教师") == final
    assert model.call_count == 1


@pytest.mark.parametrize("selection", [(50, None), (60, "工人"), (60, None), (70, "教师")])
def test_selection_change_is_rejected_while_original_generation_continues(background, monkeypatch, selection):
    service = background.service
    started, release = Event(), background.gate()

    def generate(_catalog):
        started.set()
        assert release.wait(5)
        return MODEL_YAML

    model = Mock(side_effect=generate)
    monkeypatch.setattr("src.service.catalog.service.generate_occupation_topics", model)
    original = service.select_catalog(1, 60, "教师")
    assert started.wait(1)
    with ThreadPoolExecutor(max_workers=1) as requests:
        with pytest.raises(CatalogError) as failure:
            requests.submit(service.select_catalog, 1, *selection).result(timeout=1)
    assert failure.value.status_code == 409
    assert service.member_catalog(1) == original
    assert background.repository.selections[1] == (60, "教师")
    assert list(service._jobs) == [(1, 60, "教师")]
    assert model.call_count == 1
    release.set()
    service._jobs[(1, 60, "教师")].result(timeout=3)
    current = wait_for_status(service, 1, "completed")
    assert [item["title"] for item in current["chapters"][0]["topics"]] == ["第一份工作", "第一次备课"]
    assert (1, 60, "教师") in background.repository.completed
    assert model.call_count == 1


def test_no_occupation_selection_is_locked_and_repeated_submission_is_idempotent(background, monkeypatch):
    service = background.service
    model = Mock()
    monkeypatch.setattr("src.service.catalog.service.generate_occupation_topics", model)
    original = service.select_catalog(1, 60)
    assert original["occupation"] is None
    assert service.select_catalog(1, 60, None) == original
    for selection in ((60, "教师"), (50, None)):
        with pytest.raises(CatalogError) as failure:
            service.select_catalog(1, *selection)
        assert failure.value.status_code == 409
        assert service.member_catalog(1) == original
    assert not service._jobs
    model.assert_not_called()


@pytest.mark.parametrize("failure", [TimeoutError("private model details"), RuntimeError("private model details")])
def test_background_failure_keeps_template_and_can_retry(background, monkeypatch, failure):
    service = background.service
    model = Mock(side_effect=failure)
    monkeypatch.setattr("src.service.catalog.service.generate_occupation_topics", model)
    assert service.select_catalog(1, 60, "教师")["occupation_status"] == "generating"
    failed = wait_for_status(service, 1, "failed")
    assert failed["chapters"] == BASE_CHAPTERS
    assert "稍后重试" in failed["occupation_error"]
    assert "private model details" not in str(failed)
    model.side_effect = None
    model.return_value = MODEL_YAML
    retried = service.select_catalog(1, 60, "教师")
    assert "occupation_error" not in retried
    completed = wait_for_status(service, 1, "completed")
    assert len(completed["chapters"][0]["topics"]) == 2
    assert "occupation_error" not in completed
    assert model.call_count == 2


def test_queued_obsolete_selection_skips_model_call(background, monkeypatch):
    service = background.service
    started = {user_id: Event() for user_id in (1, 2)}
    release = background.gate()

    def generate(catalog):
        user_id = int(catalog["occupation"])
        assert user_id in started, "过期的排队任务不应调用模型"
        started[user_id].set()
        assert release.wait(5)
        return EMPTY_YAML

    model = Mock(side_effect=generate)
    monkeypatch.setattr("src.service.catalog.service.generate_occupation_topics", model)
    service.select_catalog(1, 60, "1")
    service.select_catalog(2, 60, "2")
    assert all(event.wait(1) for event in started.values())
    service.select_catalog(3, 60, "3")
    # 模拟独立维护操作改变记录，验证后台对过期排队任务仍保留防御检查。
    with background.repository.lock:
        background.repository.selections[3] = (50, None)
    release.set()
    service._jobs[(3, 60, "3")].result(timeout=3)
    assert model.call_count == 2
    current = service.member_catalog(3)
    assert current["birth_decade"] == 50
    assert "occupation_status" not in current


@pytest.mark.parametrize("saved", [True, False], ids=["saved-after-first-read", "obsolete-job-skipped"])
def test_finished_job_status_follows_persisted_result(background, monkeypatch, saved):
    service, repository = background.service, background.repository
    old_catalog = repository.member_catalog(1, 60, "教师")
    final_catalog = (
        repository.append_occupation_topics(1, MODEL_YAML, birth_decade=60, occupation="教师")
        if saved else deepcopy(old_catalog)
    )
    read = Mock(side_effect=[old_catalog, final_catalog])
    monkeypatch.setattr(repository, "member_catalog", read)
    job = Future()
    job.set_result(saved)
    service._jobs[(1, 60, "教师")] = job

    first = service.member_catalog(1)
    assert first["chapters"] == BASE_CHAPTERS
    assert first["occupation_status"] == ("generating" if saved else "idle")
    assert read.call_count == 1
    second = service.member_catalog(1)
    assert second["occupation_status"] == ("completed" if saved else "idle")
    assert [item["title"] for item in second["chapters"][0]["topics"]] == (
        ["第一份工作", "第一次备课"] if saved else ["第一份工作"]
    )
    assert read.call_count == 2


def test_topic_timeout_is_1000_without_changing_other_calls_or_outer_limits(background, monkeypatch):
    monkeypatch.setenv("API_KEY", "unit-test-placeholder-key")
    monkeypatch.setenv("BASE_URL", "https://model.example.invalid/v1")
    monkeypatch.setenv("MANJI_TEXT_TIMEOUT_SECONDS", "60")
    instance = Mock()
    instance.invoke.return_value = AIMessage(content=EMPTY_YAML)
    constructor = Mock(return_value=instance)
    monkeypatch.setattr(qwen, "ChatOpenAI", constructor)
    catalog = background.repository.member_catalog(1, 60, "教师")
    assert generate_occupation_topics(catalog) == EMPTY_YAML
    qwen.call_qwen([("user", "普通请求")])
    with qwen.qwen_timeout_limit(7):
        generate_occupation_topics(catalog)
        qwen.call_qwen([("user", "受语音等待预算限制的请求")])
    qwen.call_qwen([("user", "下一条普通请求")])
    assert [call.kwargs["timeout"] for call in constructor.call_args_list] == [1000, 60, 7, 7, 60]
    assert constructor.call_args_list[0].kwargs["extra_body"] == {"enable_thinking": True}
    assert constructor.call_args_list[1].kwargs["extra_body"] == {"enable_thinking": False}

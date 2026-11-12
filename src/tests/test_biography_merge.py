"""传记全文的生成、保存、失败重试和账号隔离。"""

from copy import deepcopy
import json
from unittest.mock import Mock

from langchain_core.messages import AIMessage, HumanMessage
import psycopg
import pytest

from src.service.biography import BiographyRepository, BiographyService
from src.service.biography import service as biography
from src.tests.test_guest_auth import guest_database  # noqa: F401
from src.tests.test_home import save_interview, save_story
from src.tests.test_revision_postprocessing import revision_database  # noqa: F401


def story_state(**changes):
    return {
        "story_id": 7, "title": "进城工作", "body": "后来我进城做了木工。",
        **changes,
    }


def repository_with(body="", **context):
    current = {"body": body}
    repository = Mock()
    repository.prepare.side_effect = lambda *_, **_kwargs: deepcopy({
        **current, "story_life_event_id": None, "story_chapter": None,
        "life_events": [], "story_index": [], **context,
    })
    repository.get.side_effect = lambda *_: deepcopy(current) if current["body"] else None

    def save(_user_id, body):
        current["body"] = body
        return deepcopy(current)

    repository.save.side_effect = save
    return repository, current


@pytest.mark.parametrize("chapter", [None, {"id": 3, "title": "青年", "sort_order": 3}])
def test_first_story_generates_and_saves_a_structured_initial_biography(monkeypatch, chapter):
    repository, current = repository_with(story_chapter=chapter)
    body = "一、进城后的生活\n\n（一）学木工\n\n后来我进城做了木工。"
    model = Mock(return_value=json.dumps({"body": body}, ensure_ascii=False))
    monkeypatch.setattr(biography, "call_qwen", model)

    assert BiographyService(repository).merge_story(1, story_state()) == {"body": body}
    assert current["body"] == body
    model.assert_called_once()
    material = json.loads(model.call_args.args[0][1][1])
    assert material["existing_biography"] == ""
    assert material["story"]["life_event_id"] is None
    assert material["story"]["chapter"] == chapter
    assert material["life_events"] == [] and material["story_index"] == []
    repository.prepare.assert_called_once_with(1, 7, revision_id=None)


def test_full_manuscript_and_story_are_merged_without_chapter_assignment(monkeypatch):
    old = "我小时候住在河边。\n\n父亲教我辨认木材。"
    merged = "我小时候住在河边。父亲教我辨认木材。\n\n后来我进城做了木工。"
    events = [{"id": 5, "title": "进城工作", "summary": "开始学习手艺。", "life_stage": "青年", "time_text": "十八岁"}]
    index = [{
        "story_id": 3, "title": "父亲的手艺", "summary": "父亲教我认木材。", "life_event_id": None,
        "chapter": {"id": 1, "title": "童年", "sort_order": 1},
    }]
    repository, current = repository_with(old, story_life_event_id=5, life_events=events, story_index=index)
    model = Mock(return_value=json.dumps({"body": merged}))
    monkeypatch.setattr(biography, "call_qwen", model)

    BiographyService(repository).merge_story(1, story_state(chapter_id=None, life_event_id=99))

    material = json.loads(model.call_args.args[0][1][1])
    assert material == {
        "existing_biography": old,
        "story": {"title": "进城工作", "body": "后来我进城做了木工。", "life_event_id": 5, "chapter": None},
        "life_events": events,
        "story_index": index,
    }
    assert current["body"] == merged


def test_supplement_sends_the_updated_story_to_merge(monkeypatch):
    repository, current = repository_with("我在十六岁时进城。")
    model = Mock(return_value='{"body":"我在十八岁时进城。"}')
    monkeypatch.setattr(biography, "call_qwen", model)

    BiographyService(repository).merge_story(1, story_state(body="我记错了，是十八岁时进城。", revision_id=11))

    material = json.loads(model.call_args.args[0][1][1])
    assert material["story"]["body"] == "我记错了，是十八岁时进城。"
    assert current["body"] == "我在十八岁时进城。"
    repository.prepare.assert_called_once_with(1, 7, revision_id=11)


@pytest.mark.parametrize("output", [None, '{}', '{"body":""}', '{"body":"正文","extra":1}'])
def test_failure_keeps_old_body_and_can_retry(monkeypatch, output):
    repository, current = repository_with("已有传记。")
    model = Mock(side_effect=[TimeoutError("unavailable") if output is None else output, '{"body":"已有传记。新增经历。"}'])
    monkeypatch.setattr(biography, "call_qwen", model)
    service = BiographyService(repository)

    with pytest.raises((TimeoutError, ValueError)):
        service.merge_story(1, story_state())

    assert current["body"] == "已有传记。"
    repository.save.assert_not_called()
    assert service.merge_story(1, story_state()) == {"body": "已有传记。新增经历。"}


@pytest.mark.parametrize("changes", [{"story_id": None}, {"story_id": 0}, {"body": ""}])
def test_invalid_saved_story_is_rejected_before_reading_or_generating(changes):
    repository = Mock()
    with pytest.raises(ValueError):
        BiographyService(repository).merge_story(1, story_state(**changes))
    repository.prepare.assert_not_called()


def test_get_only_reads_the_saved_body(monkeypatch):
    repository, current = repository_with()
    model = Mock(side_effect=AssertionError("读取传记不得生成正文"))
    monkeypatch.setattr(biography, "call_qwen", model)
    service = BiographyService(repository)

    assert service.get(1) is None
    current["body"] = "已保存全文。"
    assert service.get(1)["body"] == "已保存全文。"
    repository.prepare.assert_not_called()
    repository.save.assert_not_called()
    model.assert_not_called()


def add_user(database, name):
    with psycopg.connect(database) as connection:
        return connection.execute(
            "INSERT INTO users(username, password) VALUES(%s, 'test-hash') RETURNING id", (name,),
        ).fetchone()[0]


def test_database_baseline_keeps_history_order_global_stories_and_account_isolation(guest_database):
    owner = add_user(guest_database, "owner")
    other = add_user(guest_database, "other")
    childhood = save_story(guest_database, owner, "童年旧事", chapter_id=1)
    youth = save_story(guest_database, owner, "少年旧事", chapter_id=2)
    session = save_interview(guest_database, owner, [
        AIMessage(content="随意聊聊", additional_kwargs={"interview_context": {"interview_scope": "global"}}),
        HumanMessage(content="多年以后我搬了家。"), AIMessage(content="请继续。"),
    ], finished=True)
    global_story = save_story(guest_database, owner, "搬家", completed=False)
    with psycopg.connect(guest_database) as connection:
        connection.execute("UPDATE story SET source_session_id = %s WHERE id = %s", (session, global_story))
    save_story(guest_database, owner, "无章节旧记录", completed=False)
    foreign = save_story(guest_database, other, "另一个账号")
    target = save_story(guest_database, owner, "本次新故事")
    with psycopg.connect(guest_database) as connection:
        event = connection.execute(
            "INSERT INTO life_events (user_id, title, summary, life_stage, time_text) "
            "VALUES (%s, '老家的生活', '在老家长大的经历。', '童年', '小时候') RETURNING id", (owner,),
        ).fetchone()[0]
        future_event = connection.execute(
            "INSERT INTO life_events (user_id, title, summary) VALUES (%s, '工作经历', '尚未讲述。') RETURNING id", (owner,),
        ).fetchone()[0]
        foreign_event = connection.execute(
            "INSERT INTO life_events (user_id, title) VALUES (%s, '他人的经历') RETURNING id", (other,),
        ).fetchone()[0]
        connection.execute("UPDATE story SET life_event_id = %s WHERE id IN (%s, %s)", (event, childhood, target))
        connection.execute("UPDATE story SET life_event_id = %s WHERE id = %s", (foreign_event, youth))
        connection.execute("UPDATE story SET summary = '童年片段摘要。' WHERE id = %s", (childhood,))
    repository = BiographyRepository(guest_database)

    prepared = repository.prepare(owner, target)

    assert prepared["body"] == "童年旧事\n\n正文：童年旧事\n\n少年旧事\n\n正文：少年旧事\n\n搬家\n\n正文：搬家"
    assert prepared["story_life_event_id"] == event
    assert prepared["story_chapter"] == {"id": 1, "title": "童年", "sort_order": 1}
    assert [row["id"] for row in prepared["life_events"]] == [event, future_event]
    assert prepared["life_events"][0] == {
        "id": event, "title": "老家的生活", "summary": "在老家长大的经历。", "life_stage": "童年", "time_text": "小时候",
    }
    assert [row["story_id"] for row in prepared["story_index"]] == [childhood, youth, global_story]
    assert prepared["story_index"][0] == {
        "story_id": childhood, "title": "童年旧事", "summary": "童年片段摘要。", "life_event_id": event,
        "chapter": {"id": 1, "title": "童年", "sort_order": 1},
    }
    assert prepared["story_index"][1]["life_event_id"] is None
    assert prepared["story_index"][1]["chapter"] == {"id": 2, "title": "少年", "sort_order": 2}
    assert prepared["story_index"][2]["chapter"] is None
    assert repository.prepare(owner, global_story)["story_chapter"] is None
    assert all(set(row) == {"story_id", "title", "summary", "life_event_id", "chapter"} for row in prepared["story_index"])
    assert repository.get(owner) is None
    with pytest.raises(ValueError, match="未找到"):
        repository.prepare(owner, foreign)

    repository.save(owner, "已保存的完整传记。")
    with psycopg.connect(guest_database) as connection:
        connection.execute("UPDATE story SET life_event_id = %s WHERE id = %s", (foreign_event, target))
    saved = repository.prepare(owner, target)
    assert saved["body"] == "已保存的完整传记。"
    assert saved["story_life_event_id"] is None
    assert saved["story_chapter"] == prepared["story_chapter"]
    assert saved["life_events"] == prepared["life_events"]
    assert saved["story_index"] == prepared["story_index"]


@pytest.mark.parametrize("revision_event,status,version,expected", [
    ("own", "applied", 3, "own"),
    ("own", "completed", 3, "own"),
    (None, "applied", 2, "current"),
    (None, "applied", 3, None),
    ("foreign", "applied", 2, None),
])
def test_revision_context_uses_its_saved_association_without_borrowing_newer_story_event(
    revision_database, revision_event, status, version, expected,
):
    with psycopg.connect(revision_database) as connection:
        ids = {}
        for name, owner in (("own", 1), ("current", 1), ("foreign", 2)):
            ids[name] = connection.execute(
                "INSERT INTO life_events (user_id, title) VALUES (%s, %s) RETURNING id", (owner, name),
            ).fetchone()[0]
        connection.execute("UPDATE story SET version = %s, life_event_id = %s WHERE id = 1", (version, ids["current"]))
        connection.execute(
            "UPDATE story_revisions SET life_event_id = %s, status = %s WHERE id = 1", (ids.get(revision_event), status),
        )

    prepared = BiographyRepository(revision_database).prepare(1, 1, revision_id=1)

    assert prepared["story_life_event_id"] == ids.get(expected)


@pytest.mark.parametrize("changes", [
    "user_id = 2", "story_id = 2", "status = 'pending', applied_version = NULL",
])
def test_invalid_revision_cannot_supply_biography_context(revision_database, changes):
    with psycopg.connect(revision_database) as connection:
        connection.execute("INSERT INTO story (user_id, title, body, chapter_id) VALUES (1, '另一篇', '另一篇正文。', 1)")
        connection.execute("UPDATE story_revisions SET " + changes + " WHERE id = 1")
    with pytest.raises(ValueError):
        BiographyRepository(revision_database).prepare(1, 1, revision_id=1)


def test_database_save_replaces_only_the_owners_body_and_survives_restart(guest_database):
    owner = add_user(guest_database, "owner")
    other = add_user(guest_database, "other")
    repository = BiographyRepository(guest_database)

    saved = repository.save(owner, "第一篇。")
    assert saved["body"] == "第一篇。"
    assert saved["updated_time"] is not None
    assert repository.get(other) is None
    repository.save(other, "另一个用户的传记。")
    updated = repository.save(owner, "新版全文。")
    restarted = BiographyRepository(guest_database)
    assert restarted.get(owner) == updated
    assert restarted.get(other)["body"] == "另一个用户的传记。"
    with psycopg.connect(guest_database) as connection:
        assert connection.execute("SELECT count(*) FROM biography WHERE user_id = %s", (owner,)).fetchone() == (1,)

    with pytest.raises(ValueError, match="不能为空"):
        repository.save(owner, " ")
    assert restarted.get(owner) == updated

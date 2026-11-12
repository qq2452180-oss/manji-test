"""同一访谈在多个进程重复成文时，只保存和传播一个实际结果。"""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import Mock

from langchain_core.messages import AIMessage, HumanMessage
import psycopg
import pytest

from src.langgraph.node import writing
from src.service.media.repository import MediaRepository
from src.service.story import StoryRepository
from src.tests.test_biography_merge import add_user
from src.tests.test_guest_auth import guest_database  # noqa: F401
from src.tests.test_home import save_interview


@pytest.mark.parametrize("chapter_id", [1, None], ids=["chapter", "global"])
def test_concurrent_same_session_creates_one_story(guest_database, chapter_id):
    owner = add_user(guest_database, "owner")
    session_id = save_interview(guest_database, owner, [
        AIMessage(content="讲讲往事", additional_kwargs={"interview_context": {"interview_scope": "global"}}),
        HumanMessage(content="我小时候住在乡下。"), AIMessage(content="请继续。"),
    ], finished=True)
    ready = Barrier(2)

    def create(index):
        repository = StoryRepository(guest_database)
        ready.wait(timeout=5)
        return repository.create(owner, f"候选标题{index}", f"候选正文{index}",
                                 chapter_id=chapter_id, source_session_id=session_id)

    with ThreadPoolExecutor(max_workers=2) as executor:
        identifiers = list(executor.map(create, [1, 2]))
    assert identifiers[0] == identifiers[1]
    with psycopg.connect(guest_database) as connection:
        rows = connection.execute(
            "SELECT id, title, body FROM story WHERE user_id=%s AND source_session_id=%s",
            (owner, session_id),
        ).fetchall()
    assert len(rows) == 1
    story_id, title, body = rows[0]
    assert title in {"候选标题1", "候选标题2"}
    saved = StoryRepository(guest_database).get_by_session(owner, session_id)
    assert (saved["story_id"], saved["title"], saved["body"]) == (story_id, title, body)


def test_existing_source_does_not_bypass_photo_ownership_validation(guest_database):
    owner = add_user(guest_database, "owner")
    other = add_user(guest_database, "other")
    session_id = save_interview(guest_database, owner, [])
    other_session = save_interview(guest_database, other, [])
    repository = StoryRepository(guest_database)
    story_id = repository.create(owner, "原故事", "原正文", chapter_id=1, source_session_id=session_id)
    foreign_photo = MediaRepository(guest_database).create(other, other_session, "foreign.jpg")
    with pytest.raises(ValueError, match="不属于当前用户和访谈"):
        repository.create(owner, "重复候选", "新正文", chapter_id=1, source_session_id=session_id,
                          photo_layout=[{"media_id": foreign_photo, "after_paragraph": None}])
    saved = repository.get_by_session(owner, session_id)
    assert saved["story_id"] == story_id
    assert saved["body"] == "原正文"
    assert saved["photo_layout"] == []


def test_losing_model_candidate_uses_the_winning_persisted_story(monkeypatch):
    repository = Mock(spec=StoryRepository)
    winner = {
        "story_id": 12, "title": "已经保存的标题", "body": "已经保存的正文。",
        "chapter_id": None, "source_session_id": "5",
        "profile_processed": True, "life_event_processed": True, "summary": "已有摘要。",
    }
    repository.get_by_session.side_effect = [None, winner]
    repository.create.return_value = winner["story_id"]
    model = Mock(return_value='{"title":"迟到的候选标题","body":"迟到的候选正文。"}')
    monkeypatch.setattr(writing, "call_qwen", model)
    state = {
        "user_id": 1, "source_session_id": "5", "interview_finished": True,
        "interview_context": {"interview_scope": "global"},
        "messages": [HumanMessage(id="1", content="我小时候住在乡下。")],
    }

    result = writing.writing_node(state, repository=repository)

    assert result == winner
    assert repository.create.call_args.kwargs["body"] == "迟到的候选正文。"
    assert repository.get_by_session.call_count == 2

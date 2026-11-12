"""首次使用判断读取已保存开场；仅使用专用测试数据库的隔离 schema。"""

from langchain_core.messages import AIMessage, HumanMessage

from src.common.dialogue.message_ids import messages_to_context
from src.service.interview.repository import InterviewSessionRepository
from src.tests.test_life_event_repository import life_event_database  # noqa: F401


def test_has_opening_counts_saved_assistant_text_only_and_isolates_users(life_event_database):
    repository = InterviewSessionRepository(life_event_database)
    assert repository.has_opening(1) is False
    empty = repository.create(1)
    assert repository.has_opening(1) is False

    for message in (
        HumanMessage(id="1", content="我还没有看到开场。"),
        AIMessage(id="1", content=" \n\t"),
        AIMessage(id="1", content=[{"type": "text", "text": "非文字开场格式"}]),
    ):
        repository.save(1, empty["id"], messages_to_context([message]))
        assert repository.has_opening(1) is False

    other = repository.create(2)
    repository.save(2, other["id"], messages_to_context([AIMessage(id="1", content="您好，我是小暖。")]))
    assert repository.has_opening(2) is True
    assert repository.has_opening(1) is False

    repository.save(1, empty["id"], messages_to_context([AIMessage(id="1", content="咱们慢慢聊。")]))
    assert repository.has_user_input(1) is False
    assert repository.get(1, empty["id"])["finish_time"] is None
    assert InterviewSessionRepository(life_event_database).has_opening(1) is True
    assert repository.has_opening(999) is False

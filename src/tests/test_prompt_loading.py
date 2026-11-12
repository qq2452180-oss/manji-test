"""验证当前业务实际使用的提示词文件。"""

import pytest

from src.langgraph import prompt
from src.langgraph.node.opening_context import opening_context_data
from src.service.biography.service import _load_merge_prompt


def test_returning_opening_does_not_receive_the_first_use_introduction_example():
    fields = {"previous_story_id": None, "previous_story_summary": ""}
    first = opening_context_data({**fields, "mode": "first"})
    returning = opening_context_data({**fields, "mode": "returning_without_summary"})
    assert '您好，我是小暖' in first
    assert '您好，我是小暖' not in returning
    assert '即使画像和故事记忆为空' in returning
    assert '您好，我是小暖' not in prompt.load_interview_system_prompt()


@pytest.mark.parametrize("loader_name", prompt.__all__)
def test_active_prompt_can_load_its_real_file(loader_name):
    # 不模拟文件读取，避免已删除的文件引用被业务层 mock 掩盖。
    loaded = getattr(prompt, loader_name)()
    assert isinstance(loaded, str) and loaded.strip()


def test_biography_service_loads_its_local_merge_prompt():
    loaded = _load_merge_prompt()
    assert '传记全文融合' in loaded
    assert 'existing_biography' in loaded

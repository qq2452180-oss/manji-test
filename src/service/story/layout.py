"""成稿段落编号；与 Web StoryContent 使用相同的换行和空段处理规则。"""

import re


def split_story_paragraphs(body: str) -> list[str]:
    return [text.strip() for text in re.split(r"\r\n|[\n\r]", body) if text.strip()]

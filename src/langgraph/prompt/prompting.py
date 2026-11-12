"""每个任务读取一个独立提示词文件，不拼接不同任务的输出协议。"""

from pathlib import Path

PROMPT_DIR = Path(__file__).resolve().parent


def _read_prompt(relative_path: str) -> str:
    """每次读取文件最新内容；缺失或空文件直接报错。"""

    path = PROMPT_DIR / relative_path
    prompt = path.read_text(encoding="utf-8").strip()
    if not prompt:
        raise ValueError(f"prompt file is empty: {path}")
    return prompt


def load_interview_system_prompt() -> str:
    """文字、语音及图片访谈：返回小暖的纯文本回复。"""

    return _read_prompt("interview/interview_system.md")


def load_biography_organizer_system_prompt() -> str:
    """传记成文：返回包含 title、body 的 JSON。"""

    return _read_prompt("biography_organizer/writing_system.md")


def load_profile_updater_system_prompt() -> str:
    """人物画像提取：返回包含 updates、reviews 的 JSON。"""

    return _read_prompt("profile/user_profile.md")


def load_life_event_extraction_system_prompt() -> str:
    """人生经历索引提取：返回 create、update 或 skip 建议 JSON。"""

    return _read_prompt("event/life_event.md")


def load_story_summary_system_prompt() -> str:
    """已保存故事的摘要：返回只包含 summary 的 JSON。"""

    return _read_prompt("story_summary/summary.md")

"""当前业务使用的提示词加载入口。"""

from .prompting import (
    load_biography_organizer_system_prompt,
    load_interview_system_prompt,
    load_life_event_extraction_system_prompt,
    load_profile_updater_system_prompt,
    load_story_summary_system_prompt,
)

__all__ = [
    "load_biography_organizer_system_prompt",
    "load_interview_system_prompt",
    "load_life_event_extraction_system_prompt",
    "load_profile_updater_system_prompt",
    "load_story_summary_system_prompt",
]

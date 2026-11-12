"""编排故事读取、经历归纳、建议校验与索引保存。"""

from ..story import StoryRepository
from ..profile.repository import ProfileRepository
from . import extractor, validator
from .repository import LifeEventRepository


class LifeEventService:
    def __init__(
        self, repository: LifeEventRepository, stories: StoryRepository,
        profiles: ProfileRepository,
    ) -> None:
        self._repository = repository
        self._stories = stories
        self._profiles = profiles

    def get_profile(self, user_id: int) -> dict:
        """返回当前用户的人物画像，没有记录时使用空画像。"""
        return self._profiles.get_profile(user_id) or {}

    def get_life_events(self, user_id: int) -> list[dict]:
        """返回当前用户已有的经历索引，没有记录时返回空列表。"""
        return self._repository.get_life_events(user_id)

    def get_story(self, user_id: int, story_id: int, *, revision_id: int | None = None) -> dict | None:
        """读取当前用户故事的标题和完整正文；未找到时返回 None。"""
        options = {"revision_id": revision_id} if revision_id is not None else {}
        story = self._stories.get_for_summary(user_id=user_id, story_id=story_id, **options)
        if story is None:
            return None
        return {"title": story["title"], "body": story["body"]}

    def return_life_event_input(self, user_id: int, story_id: int, *, revision_id: int | None = None) -> dict:
        """组装经历归纳提示词要求的故事、已有经历索引和人物画像。"""
        options = {"revision_id": revision_id} if revision_id is not None else {}
        story = self.get_story(user_id, story_id, **options)
        if story is None:
            raise ValueError("未找到该用户的故事")
        return {
            "story": {"story_id": story_id, **story},
            "existing_events": self.get_life_events(user_id),
            "user_profile": self.get_profile(user_id),
        }

    def extract_life_event_updates(self, user_id: int, story_id: int) -> dict:
        """读取归纳所需的数据，返回模型给出的待校验经历建议。"""
        life_event_input = self.return_life_event_input(user_id, story_id)
        return extractor.extract_life_event_updates(life_event_input)

    def update_life_events(
        self, user_id: int, story_id: int, *, once: bool = False, revision_id: int | None = None,
    ) -> dict:
        """归纳并校验本次故事的经历建议，保存经历及故事关联。"""
        options = {"revision_id": revision_id} if revision_id is not None else {}
        life_event_input = self.return_life_event_input(user_id, story_id, **options)
        result = extractor.extract_life_event_updates(life_event_input)
        suggestion = validator.validate_life_event_suggestion(
            result, life_event_input["existing_events"],
        )
        if once or revision_id is not None:
            return self._repository.save_suggestion(user_id, story_id, suggestion, once=True, **options)
        return self._repository.save_suggestion(user_id, story_id, suggestion)

"""读取访谈记忆与数据库话题，不生成规划或修改用户资料。"""

from ..catalog import CatalogError, CatalogService
from ..life_event.repository import LifeEventRepository
from ..profile.repository import ProfileRepository
from ..story import StoryRepository


def load_selected_topic(topic_id: int | None, *, catalog: CatalogService | None = None) -> dict:
    """选择启用的话题及章节，只保留本场使用的目录快照。"""
    if topic_id is None:
        raise ValueError("请先选择章节下的话题，再开始访谈")
    if type(topic_id) is not int or not 0 < topic_id <= 9223372036854775807:
        raise ValueError("话题编号无效")
    if catalog is None:
        raise CatalogError("话题目录暂时无法读取，请稍后重试", 503)
    topic = catalog.get_enabled_topic(topic_id)
    if topic is None:
        raise ValueError("所选话题不存在或已停用，请重新选择")
    return {key: topic[key] for key in ("id", "chapter_id", "chapter_title", "title", "description")}


class InterviewMemoryService:
    def __init__(
        self, profiles: ProfileRepository, events: LifeEventRepository,
        stories: StoryRepository,
    ) -> None:
        self._profiles = profiles
        self._events = events
        self._stories = stories

    def build(self, user_id: int, *, history: dict | None = None) -> dict:
        """读取本人全部故事摘要；上一篇仅用 ID 引用，章节入口移除该标记。"""
        if history is None:
            history = self._stories.get_opening_history(user_id)
        stories = self._stories.list_for_interview(user_id)
        return {
            "user_profile": self._profiles.get_profile(user_id) or {},
            "previous_story_id": history["previous_story"]["story_id"] if history["previous_story"] else None,
            "life_event_context": {
                "events": self._events.get_life_events(user_id),
                "stories": [
                    {**story, "created_at": story["created_at"].isoformat()}
                    for story in stories
                ],
            },
        }

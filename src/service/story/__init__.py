"""成文故事的数据库存储。"""

from .repository import StoryRepository

__all__ = ["StoryRepository"]

from .revisions import StoryVersionConflict

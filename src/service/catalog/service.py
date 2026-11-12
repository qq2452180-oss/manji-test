"""提供公开目录及访谈可选话题。"""

import psycopg

from .repository import CatalogRepository


class CatalogError(ValueError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class CatalogService:
    def __init__(self, repository: CatalogRepository) -> None:
        self._repository = repository

    def list_catalog(self) -> dict:
        try:
            chapters = self._repository.list_catalog()
        except psycopg.Error as exc:
            raise CatalogError("话题目录暂时无法读取，请稍后重试", 503) from exc
        return {"chapters": chapters}

    def get_enabled_topic(self, topic_id: int) -> dict | None:
        try:
            return self._repository.get_enabled_topic(topic_id)
        except psycopg.Error as exc:
            raise CatalogError("话题目录暂时无法读取，请稍后重试", 503) from exc

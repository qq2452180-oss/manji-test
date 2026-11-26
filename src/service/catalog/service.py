"""提供公开目录及访谈可选话题。"""

from concurrent.futures import Future, ThreadPoolExecutor
from threading import Lock

import psycopg

from .occupation_topics import generate_occupation_topics
from .repository import CatalogRepository, CatalogSelectionLocked


class CatalogError(ValueError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class CatalogService:
    def __init__(self, repository: CatalogRepository) -> None:
        self._repository = repository
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="occupation-topics")
        self._jobs: dict[tuple[int, int, str], Future[bool]] = {}
        self._jobs_lock = Lock()

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    def list_catalog(self) -> dict:
        try:
            chapters = self._repository.list_catalog()
        except psycopg.Error as exc:
            raise CatalogError("话题目录暂时无法读取，请稍后重试", 503) from exc
        return {"chapters": chapters}

    def member_catalog(self, user_id: int, decade: int | None = None, occupation: str | None = None) -> dict:
        try:
            catalog = self._repository.member_catalog(user_id, decade, occupation)
            key = (user_id, catalog["birth_decade"], catalog["occupation"])
            with self._jobs_lock:
                job = self._jobs.get(key)
            if job is None or catalog.get("occupation_status") == "completed" or job.cancelled():
                return catalog
            if not job.done():
                return {**catalog, "occupation_status": "generating"}
            if job.exception() is not None:
                return {**catalog, "occupation_status": "failed",
                        "occupation_error": "职业话题暂时未能补充，您可以先讲已有话题，或稍后重试。"}
            # 已写入但本次读到旧目录时，继续轮询，直到目录本身带有完成标记。
            return {**catalog, "occupation_status": "generating"} if job.result() else catalog
        except CatalogSelectionLocked as exc:
            raise CatalogError(str(exc), 409) from exc
        except psycopg.Error as exc:
            raise CatalogError("年代目录暂时无法读取，请稍后重试", 503) from exc

    def select_catalog(self, user_id: int, decade: int, occupation: str | None = None) -> dict:
        catalog = self.member_catalog(user_id, decade, occupation)
        if not occupation or catalog.get("occupation_status") == "completed":
            return catalog
        key = (user_id, decade, occupation)
        with self._jobs_lock:
            job = self._jobs.get(key)
            if job is None or job.done():
                self._jobs[key] = self._executor.submit(self._generate_topics, user_id, decade, occupation)
        catalog.pop("occupation_error", None)
        return {**catalog, "occupation_status": "generating"}

    def _generate_topics(self, user_id: int, decade: int, occupation: str) -> bool:
        catalog = self._repository.member_catalog(user_id)
        if (catalog["birth_decade"], catalog["occupation"]) != (decade, occupation):
            return False
        if catalog.get("occupation_status") == "completed":
            return True
        source = generate_occupation_topics(catalog)
        saved = self._repository.append_occupation_topics(
            user_id, source, birth_decade=decade, occupation=occupation,
        )
        return (saved["birth_decade"], saved["occupation"]) == (decade, occupation) \
            and saved.get("occupation_status") == "completed"

    def get_enabled_topic(self, topic_id: int, *, user_id: int | None = None) -> dict | None:
        try:
            return self._repository.get_enabled_topic(topic_id, user_id=user_id)
        except psycopg.Error as exc:
            raise CatalogError("话题目录暂时无法读取，请稍后重试", 503) from exc

    def append_occupation_topics(self, user_id: int, source: str) -> dict:
        """追加模型返回的职业话题 YAML，保留原题并返回个人目录。"""
        return self._repository.append_occupation_topics(user_id, source)

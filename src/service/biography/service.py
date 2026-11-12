"""把本次故事融入用户的传记全文。"""

from collections.abc import Mapping
import json
from pathlib import Path

from ...langgraph.llm import call_qwen
from .repository import BiographyRepository


class BiographyService:
    def __init__(self, repository: BiographyRepository) -> None:
        self._repository = repository

    def get(self, user_id: int) -> dict | None:
        return self._repository.get(user_id)

    def merge_story(self, user_id: int, story: Mapping) -> dict:
        """读取旧稿、融合本次故事并保存新版全文。"""
        story_id = story.get("story_id")
        if any(type(value) is not int or value <= 0 for value in (user_id, story_id)):
            raise ValueError("传记融合缺少有效的用户或故事")
        if any(not isinstance(story.get(key), str) or not story[key].strip() for key in ("title", "body")):
            raise ValueError("已保存故事缺少有效标题或正文")

        current = self._repository.prepare(user_id, story_id, revision_id=story.get("revision_id"))
        raw = call_qwen([
            ("system", _load_merge_prompt()),
            ("user", json.dumps({
                "existing_biography": current["body"],
                "story": {
                    "title": story["title"], "body": story["body"],
                    "life_event_id": current["story_life_event_id"],
                    "chapter": current["story_chapter"],
                },
                "life_events": current["life_events"],
                "story_index": current["story_index"],
            }, ensure_ascii=False)),
        ], json_output=True)
        return self._repository.save(user_id, _parse_body(raw))


def _load_merge_prompt() -> str:
    path = Path(__file__).with_name("merge_system.md")
    prompt = path.read_text(encoding="utf-8").strip()
    if not prompt:
        raise ValueError(f"prompt file is empty: {path}")
    return prompt


def _parse_body(raw: str) -> str:
    lines = raw.strip().splitlines()
    if len(lines) >= 3 and lines[0].strip().casefold() in {"```", "```json"} and lines[-1].strip() == "```":
        raw = "\n".join(lines[1:-1])
    payload = json.loads(raw)
    if (not isinstance(payload, dict) or set(payload) != {"body"}
            or not isinstance(payload["body"], str) or not payload["body"].strip()):
        raise ValueError("传记融合回复必须且只能包含非空字符串 body")
    return payload["body"].strip()

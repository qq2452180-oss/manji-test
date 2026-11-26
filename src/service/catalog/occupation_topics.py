from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
import yaml

from ...langgraph.llm import call_qwen_thinking
from ...langgraph.prompt import load_occupation_topics_system_prompt
from .templates import parse_volumes


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class _Topic(_Input):
    title: str = Field(min_length=1)
    description: str = Field(min_length=1)


class _Section(_Input):
    section: str = Field(min_length=1)
    topics: list[_Topic]


class _Volume(_Input):
    decade: str = Field(min_length=1)
    sections: list[_Section]


def generate_occupation_topics(catalog: dict, *, reasoning_effort: str = "high") -> str:
    volumes = []
    for chapter in catalog["chapters"]:
        sections = {}
        for topic in chapter["topics"]:
            section = sections.setdefault(topic["section_title"], {"section": topic["section_title"], "topics": []})
            section["topics"].append({"title": topic["title"], "description": topic["description"]})
        volumes.append({"decade": chapter["title"], "volume_title": chapter["volume_title"],
                        "sections": list(sections.values())})
    source = yaml.safe_dump({
        "birth_decade": catalog["birth_decade"], "occupation": catalog["occupation"],
        "full_biography_by_decade": {"decades": volumes},
    }, allow_unicode=True, sort_keys=False)
    return call_qwen_thinking(
        [("system", load_occupation_topics_system_prompt()), ("user", source)],
        reasoning_effort=reasoning_effort, timeout_seconds=1000,
    )


def parse_occupation_topics(source: str, chapters: list[dict]) -> list[dict]:
    """校验模型 YAML，匹配现有卷和小节，返回去重后的新增话题。"""
    volumes = TypeAdapter(list[_Volume]).validate_python(parse_volumes(source))
    by_title = {chapter["title"]: chapter for chapter in chapters}
    seen = {(topic["title"].strip(), topic["description"].strip())
            for chapter in chapters for topic in chapter["topics"]}
    additions = []
    for volume in volumes:
        chapter = by_title.get(volume.decade)
        if chapter is None:
            raise ValueError(f"话题目录中不存在卷：{volume.decade}")
        sections = {topic.get("section_title") for topic in chapter["topics"]}
        for section in volume.sections:
            if section.section not in sections:
                raise ValueError(f"{volume.decade}中不存在小节：{section.section}")
            for topic in section.topics:
                key = (topic.title, topic.description)
                if key not in seen:
                    additions.append({
                        "chapter_id": chapter["id"], "section_title": section.section,
                        "title": topic.title, "description": topic.description,
                    })
                    seen.add(key)
    return additions

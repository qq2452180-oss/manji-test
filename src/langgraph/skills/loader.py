"""读取技能目录摘要及各技能唯一的 SKILL.md，不缓存文件内容。"""

import json
from pathlib import Path
import re

import yaml


SKILLS_DIR = Path(__file__).resolve().parent
_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def _read_skill_file(directory: Path) -> str:
    root = directory.resolve()
    path = (directory / "SKILL.md").resolve()
    if not path.is_relative_to(root):
        raise ValueError(f"技能文件越出技能目录：{directory.name}")
    if not path.is_file():
        raise FileNotFoundError(f"技能文件不存在：{directory.name}")
    return path.read_text(encoding="utf-8")


def _skill_index() -> dict[str, tuple[Path, str]]:
    root = SKILLS_DIR.resolve()
    skills = {}
    for directory in sorted(root.iterdir()):
        if not directory.is_dir():
            continue
        if not directory.resolve().is_relative_to(root):
            raise ValueError(f"技能目录越出允许范围：{directory.name}")
        if not (directory / "SKILL.md").exists():
            continue
        lines = _read_skill_file(directory).splitlines()
        if not lines or lines[0].strip() != "---":
            raise ValueError(f"技能缺少 frontmatter：{directory.name}")
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        if end is None:
            raise ValueError(f"技能 frontmatter 未结束：{directory.name}")
        try:
            metadata = yaml.safe_load("\n".join(lines[1:end]))
        except yaml.YAMLError as exc:
            raise ValueError(f"技能 frontmatter 格式无效：{directory.name}") from exc
        name = metadata.get("name") if isinstance(metadata, dict) else None
        description = metadata.get("description") if isinstance(metadata, dict) else None
        if not isinstance(name, str) or not _NAME.fullmatch(name):
            raise ValueError(f"技能名称无效：{directory.name}")
        if not isinstance(description, str) or not description.strip():
            raise ValueError(f"技能描述为空或无效：{directory.name}")
        if name in skills:
            raise ValueError(f"技能名称重复：{name}")
        skills[name] = (directory, description.strip())
    return skills


def get_skill_catalog() -> str:
    """仅返回直属技能的 name/description，正文由 read_skill 按需读取。"""
    return json.dumps(
        [{"name": name, "description": description}
         for name, (_, description) in _skill_index().items()],
        ensure_ascii=False,
        indent=2,
    )


def read_skill(name: str) -> str:
    """按登记名称读取完整技能；不接受文件路径或其他资源参数。"""
    if not isinstance(name, str) or not _NAME.fullmatch(name):
        raise ValueError("技能名称无效")
    entry = _skill_index().get(name)
    if entry is None:
        raise ValueError(f"未知访谈技能：{name}")
    return _read_skill_file(entry[0])

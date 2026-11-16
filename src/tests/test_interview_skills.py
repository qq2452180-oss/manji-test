"""技能目录只暴露摘要，每项只读取唯一的 SKILL.md。"""

import json

import pytest

from src.langgraph.skills import get_skill_catalog, read_skill
from src.langgraph.skills import loader


NAMES = {
    "active-listening", "clear-speaking", "conversation-flow", "conversation-opening",
    "disagreement-dialogue", "feelings-and-choices", "interview-planning",
    "question-design", "tactful-communication",
}


def write_skill(root, name="example", description="技能说明", body="只在读取后可见的正文"):
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return directory


def test_real_catalog_contains_nine_skills_with_only_metadata():
    catalog = json.loads(get_skill_catalog())
    assert {item["name"] for item in catalog} == NAMES
    assert len(catalog) == 9
    assert all(set(item) == {"name", "description"} and item["description"] for item in catalog)


def test_each_real_skill_contains_one_file_and_reads_its_complete_content():
    for name in NAMES:
        directory = loader.SKILLS_DIR / name
        assert {path.name for path in directory.iterdir()} == {"SKILL.md"}
        expected = (directory / "SKILL.md").read_text(encoding="utf-8")
        assert read_skill(name) == expected


def test_catalog_does_not_include_body_and_changes_are_read_without_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(loader, "SKILLS_DIR", tmp_path)
    write_skill(tmp_path)
    assert json.loads(get_skill_catalog()) == [{"name": "example", "description": "技能说明"}]
    assert "只在读取后可见的正文" in read_skill("example")
    write_skill(tmp_path, description="更新说明", body="更新正文")
    assert json.loads(get_skill_catalog()) == [{"name": "example", "description": "更新说明"}]
    assert "更新正文" in read_skill("example")


@pytest.mark.parametrize("name", ["unknown-skill", "../active-listening", "active-listening/SKILL.md", "/etc/passwd", "", None])
def test_unknown_or_invalid_skill_is_rejected(name):
    with pytest.raises(ValueError, match="技能"):
        read_skill(name)


def test_catalog_ignores_nested_unregistered_skills(tmp_path, monkeypatch):
    monkeypatch.setattr(loader, "SKILLS_DIR", tmp_path)
    write_skill(tmp_path / "nested")
    assert json.loads(get_skill_catalog()) == []
    with pytest.raises(ValueError, match="未知访谈技能"):
        read_skill("example")


def test_skill_file_symlink_cannot_escape_skill_directory(tmp_path, monkeypatch):
    root = tmp_path / "skills"
    directory = write_skill(root)
    outside = tmp_path / "private.md"
    outside.write_text("不能读取的外部内容", encoding="utf-8")
    target = directory / "SKILL.md"
    target.unlink(missing_ok=True)
    target.symlink_to(outside)
    monkeypatch.setattr(loader, "SKILLS_DIR", root)
    with pytest.raises(ValueError, match="技能文件越出技能目录"):
        read_skill("example")


def test_skill_directory_symlink_cannot_escape_root(tmp_path, monkeypatch):
    root = tmp_path / "skills"
    root.mkdir()
    outside = write_skill(tmp_path / "outside")
    (root / "example").symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(loader, "SKILLS_DIR", root)
    with pytest.raises(ValueError, match="技能目录越出允许范围"):
        get_skill_catalog()

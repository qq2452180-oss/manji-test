"""画像建议只在内存中合并，不连接数据库或调用模型。"""

from copy import deepcopy

import pytest

from src.service.profile.validator import apply_profile_updates


MESSAGES = [
    {"message_id": "q1", "role": "assistant", "content": "请介绍一下自己。"},
    {"message_id": "a1", "role": "user", "content": "我出生于1960年，现在住杭州，是独生女，长期喜欢读书。"},
    {"message_id": "a2", "role": "user", "content": "我父亲务农，师傅张老师教我木工。"},
]


def update(field, operation, value, target=None, **kwargs):
    return {
        "field": field, "operation": operation, "target": target, "value": value,
        "evidence": "现在住杭州", "source_message_ids": ["a1"], "context_message_ids": [],
        **kwargs,
    }


def apply(profile, *updates, reviews=None, messages=MESSAGES):
    return apply_profile_updates(profile, {"updates": list(updates), "reviews": reviews or []}, messages)


def person(name, relationship="师傅", description="教授木工技术"):
    return {"name": name, "relationship": relationship, "description": description}


def test_set_multiple_fields_and_preserve_original_profile():
    original = {"basic_background": {"birthplace": "合肥"}, "existing_extra": {"keep": True}}
    before = deepcopy(original)
    result = apply(original,
        update("basic_background.birth_year", "set", 1960, evidence="我出生于1960年"),
        update("family_background.siblings_count", "set", 0, evidence="是独生女"),
        update("basic_background.current_location", "set", "杭州"),
    )
    assert result["profile"] == {
        "basic_background": {"birthplace": "合肥", "birth_year": 1960, "current_location": "杭州"},
        "family_background": {"siblings_count": 0}, "existing_extra": {"keep": True},
    }
    assert original == before


@pytest.mark.parametrize("empty", [None, "", []])
def test_set_can_fill_an_empty_field(empty):
    profile = {"basic_background": {"current_location": empty}}
    assert apply(profile, update("basic_background.current_location", "set", "杭州"))["profile"]["basic_background"]["current_location"] == "杭州"


@pytest.mark.parametrize("existing", [0, 2])
def test_set_cannot_overwrite_a_populated_integer_including_zero(existing):
    with pytest.raises(ValueError):
        apply({"family_background": {"siblings_count": existing}}, update("family_background.siblings_count", "set", 3))


def test_append_strings_keeps_order_and_removes_duplicates():
    profile = {"personal_life": {"interests": ["读书", "唱歌"]}}
    result = apply(profile, update("personal_life.interests", "append", ["读书", "游泳", "游泳"]))
    assert result["profile"]["personal_life"]["interests"] == ["读书", "唱歌", "游泳"]
    assert profile["personal_life"]["interests"] == ["读书", "唱歌"]


def test_replace_scalar_and_array_matches_complete_target():
    profile = {"basic_background": {"current_location": "合肥"}, "personal_life": {"interests": ["读书"]}}
    result = apply(profile,
        update("basic_background.current_location", "replace", "杭州", target="合肥"),
        update("personal_life.interests", "replace", ["读书", "游泳"], target=["读书"]),
    )
    assert result["profile"]["basic_background"]["current_location"] == "杭州"
    assert result["profile"]["personal_life"]["interests"] == ["读书", "游泳"]


def test_people_append_deduplicates_full_objects_not_names():
    teacher = person("张老师")
    colleague = person("张老师", "同事", "一起在工厂工作")
    result = apply({"important_people": [teacher]},
        update("important_people", "append", teacher),
        update("important_people", "append", colleague),
        update("important_people", "append", person(None)),
    )
    assert result["profile"]["important_people"] == [teacher, colleague, person(None)]


def test_people_replace_changes_only_unique_matching_person():
    teacher = person("张老师")
    colleague = person("张老师", "同事", "一起在工厂工作")
    refined = person("张建国", description="教授木工技术三年")
    profile = {"important_people": [teacher, colleague]}
    result = apply(profile, update("important_people", "replace", refined, target=teacher))
    assert result["profile"]["important_people"] == [refined, colleague]
    assert profile["important_people"] == [teacher, colleague]


@pytest.mark.parametrize("people,target,value", [
    ([person("张老师"), person("张老师")], person("张老师"), person("张建国")),
    ([person("张老师")], person("不存在"), person("张建国")),
    ([person("张老师")], [person("张老师")], [person("张建国")]),
    ([person("张老师"), person("李老师")], person("张老师"), person("李老师")),
])
def test_people_replace_rejects_ambiguous_missing_or_whole_array_targets(people, target, value):
    with pytest.raises(ValueError):
        apply({"important_people": people}, update("important_people", "replace", value, target=target))


@pytest.mark.parametrize("invalid", [
    update("basic_background.birth_year", "set", True),
    update("basic_background.birth_year", "set", "1960"),
    update("family_background.siblings_count", "set", -1),
    update("basic_background.current_location", "set", "杭州", target="旧值"),
    update("basic_background.current_location", "append", "杭州"),
    update("personal_life.interests", "append", "读书"),
    update("personal_life.interests", "append", [1]),
    update("personal_life.interests", "append", ["读书"], target=[]),
    update("unknown.field", "set", "杭州"),
    update("basic_background.current_location.extra", "set", "杭州"),
    update("basic_background.current_location", "delete", "杭州"),
    update("basic_background.current_location", "set", " " * 3),
    update("basic_background.current_location", "set", "字" * 51),
    update("important_people", "append", {"name": "张老师"}),
    update("important_people", "append", {**person("张老师"), "other": "额外字段"}),
])
def test_invalid_operations_and_value_types_are_rejected(invalid):
    with pytest.raises(ValueError):
        apply({}, invalid)


@pytest.mark.parametrize("target", [None, "杭州", True])
def test_replace_requires_exact_existing_target(target):
    with pytest.raises(ValueError):
        apply({"basic_background": {"current_location": "合肥"}}, update("basic_background.current_location", "replace", "上海", target=target))


@pytest.mark.parametrize("changes", [
    {"source_message_ids": []},
    {"source_message_ids": ["missing"]},
    {"source_message_ids": ["q1"]},
    {"context_message_ids": ["a2"]},
    {"context_message_ids": ["missing"]},
    {"evidence": "我在北京"},
    {"evidence": ""},
    {"evidence": "杭州我父亲"},
])
def test_evidence_cannot_be_fabricated_or_use_assistant_as_source(changes):
    with pytest.raises(ValueError):
        apply({}, update("basic_background.current_location", "set", "杭州", **changes))


def test_assistant_context_and_multiple_real_sources_are_accepted():
    suggestion = update("basic_background.current_location", "set", "杭州", source_message_ids=["a1", "a2"], context_message_ids=["q1"])
    assert apply({}, suggestion)["updates"] == [suggestion]


def test_duplicate_message_ids_cannot_be_referenced():
    duplicate = [*MESSAGES, {"message_id": "a1", "role": "user", "content": "另一条不同的消息"}]
    with pytest.raises(ValueError):
        apply({}, update("basic_background.current_location", "set", "杭州"), messages=duplicate)


def test_reviews_are_returned_without_modifying_profile():
    review = {
        "field": "basic_background.current_location", "existing_value": "合肥", "new_value": "杭州",
        "reason": "需要核实", "evidence": "现在住杭州", "source_message_ids": ["a1"], "context_message_ids": [],
    }
    profile = {"basic_background": {"current_location": "合肥"}}
    result = apply(profile, reviews=[review])
    assert result == {"profile": profile, "updates": [], "reviews": [review]}
    assert result["profile"] is not profile


def test_invalid_later_update_leaves_original_profile_unchanged():
    original = {"personal_life": {"interests": ["读书"]}}
    before = deepcopy(original)
    with pytest.raises(ValueError):
        apply(original,
            update("personal_life.interests", "append", ["唱歌"]),
            update("basic_background.birth_year", "set", False),
        )
    assert original == before


def test_replace_cannot_target_value_created_by_an_earlier_update():
    original = {"basic_background": {"current_location": "合肥"}}
    with pytest.raises(ValueError):
        apply(original,
            update("basic_background.current_location", "replace", "杭州", target="合肥"),
            update("basic_background.current_location", "replace", "杭州西湖", target="杭州"),
        )
    assert original == {"basic_background": {"current_location": "合肥"}}


def test_people_replace_cannot_target_person_appended_in_the_same_batch():
    original = {"important_people": [person("李老师")]}
    with pytest.raises(ValueError):
        apply(original,
            update("important_people", "append", person("张老师")),
            update("important_people", "replace", person("张建国"), target=person("张老师")),
        )
    assert original == {"important_people": [person("李老师")]}


@pytest.mark.parametrize("result", [{"updates": []}, {"updates": [], "reviews": [], "extra": 1}, {"updates": {}, "reviews": []}])
def test_extraction_structure_must_follow_prompt(result):
    with pytest.raises(ValueError):
        apply_profile_updates({}, result, MESSAGES)

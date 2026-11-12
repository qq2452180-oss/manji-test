"""检查模型建议，再按 set、append、replace 合并画像。"""

from copy import deepcopy

from .schema import FIELD_TYPES, Person, ProfileExtraction


def apply_profile_updates(current_profile: dict, result: dict, messages: list[dict]) -> dict:
    """有一条建议不合法就停止；原画像不变，reviews 只返回、不合并。"""
    # 1. 检查模型返回的结构，并按 ID 找到原始消息。
    extraction = ProfileExtraction.model_validate(result)
    messages_by_id = {}
    for message in messages:
        message_id = message.get("message_id")
        if not isinstance(message_id, str) or not message_id:
            continue
        if message_id in messages_by_id:
            messages_by_id[message_id] = None  # 重复 ID 不能作为证据来源。
        else:
            messages_by_id[message_id] = message

    # 2. 先核对全部建议的字段和原文来源。
    for suggestion in extraction.updates + extraction.reviews:
        _validate_evidence(suggestion, messages_by_id)

    # 3. 在副本上逐条合并。input_value 是输入时的值，current_value 是合并中的值。
    profile = deepcopy(current_profile)
    for update in extraction.updates:
        field = update.field
        operation = update.operation
        target = update.target
        new_value = deepcopy(update.value)
        _validate_value(field, new_value, operation)
        if isinstance(new_value, list):
            new_value = _remove_duplicates(new_value)

        # 普通字段如 basic_background.birth_year，人物数组则直接放在画像顶层。
        if field == "important_people":
            section = profile
            field_name = field
            input_value = current_profile.get(field)
        else:
            section_name, field_name = field.split(".")
            if profile.get(section_name) is None:
                profile[section_name] = {}
            section = profile[section_name]
            if not isinstance(section, dict):
                raise ValueError(f"{section_name} 必须为对象")
            input_section = current_profile.get(section_name) or {}
            input_value = input_section.get(field_name)
        current_value = section.get(field_name)

        if operation == "set":
            if target is not None:
                raise ValueError(f"{field}：set 的 target 必须为 null")
            if current_value not in (None, "", []):  # 0 是有效值，不算空。
                raise ValueError(f"{field}：已有内容，不能使用 set 覆盖")

        elif operation == "append":
            if FIELD_TYPES[field] is not list:
                raise ValueError(f"{field}：只有数组字段可以 append")
            if target is not None:
                raise ValueError(f"{field}：append 的 target 必须为 null")
            if current_value is None:
                current_value = []
            if not isinstance(current_value, list):
                raise ValueError(f"{field}：当前值必须为数组")
            if field == "important_people":
                new_value = [new_value]  # 人物 append 一次接收一个完整对象。
            new_value = _remove_duplicates(current_value + new_value)

        elif operation == "replace":
            if field == "important_people":
                new_value = _replace_person(input_value, current_value, target, new_value)
            else:
                if input_value in (None, "", []):
                    raise ValueError(f"{field}：原字段为空，应使用 set")
                if type(input_value) is not type(target) or input_value != target:
                    raise ValueError(f"{field}：target 与输入画像中的旧值不一致")
                if type(current_value) is not type(target) or current_value != target:
                    raise ValueError(f"{field}：本批前面的操作已修改该值，不能再次 replace")

        section[field_name] = new_value

    # 4. 返回合并后的画像和建议，数据库保存由 service 调用 repository 完成。
    suggestions = extraction.model_dump()
    return {
        "profile": profile,
        "updates": suggestions["updates"],
        "reviews": suggestions["reviews"],
    }


def _validate_evidence(suggestion, messages_by_id: dict) -> None:
    """来源必须真实存在，证据必须能在引用的用户原话中找到。"""
    field = suggestion.field
    if field not in FIELD_TYPES:
        raise ValueError(f"未知画像字段：{field}")
    if not suggestion.source_message_ids or not suggestion.evidence.strip():
        raise ValueError(f"{field}：缺少用户消息来源或原文证据")

    evidence_found = False
    for message_id in suggestion.source_message_ids:
        message = messages_by_id.get(message_id)
        if message is None:
            raise ValueError(f"{field}：用户来源消息 {message_id} 不存在或 ID 重复")
        if message["role"] != "user":
            raise ValueError(f"{field}：来源消息 {message_id} 不是用户消息")
        content = message["content"]
        if isinstance(content, str) and suggestion.evidence in content:
            evidence_found = True

    for message_id in suggestion.context_message_ids:
        message = messages_by_id.get(message_id)
        if message is None:
            raise ValueError(f"{field}：上下文消息 {message_id} 不存在或 ID 重复")
        if message["role"] != "assistant":
            raise ValueError(f"{field}：上下文消息 {message_id} 不是助手消息")

    if not evidence_found:
        raise ValueError(f"{field}：evidence 不是引用用户消息中的连续原文片段")


def _validate_value(field: str, value, operation: str) -> None:
    """检查该字段需要的是文字、整数、字符串数组还是人物对象。"""
    if field == "important_people":
        if operation in ("append", "replace"):
            _validate_person(value)
        else:
            if not isinstance(value, list):
                raise ValueError("important_people：set 的值必须为人物数组")
            for person in value:
                _validate_person(person)
        return

    expected_type = FIELD_TYPES[field]
    if expected_type is str:
        _validate_text(value, field)
    elif expected_type is int:
        minimum = 0
        if field == "basic_background.birth_year":
            minimum = 1
        if type(value) is not int or value < minimum:
            raise ValueError(f"{field} 必须为不小于 {minimum} 的整数")
    else:
        if not isinstance(value, list):
            raise ValueError(f"{field} 必须为字符串数组")
        for text in value:
            _validate_text(text, field)


def _validate_text(value, field: str) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > 50:
        raise ValueError(f"{field} 必须为 1 至 50 字的非空字符串")


def _validate_person(value) -> None:
    person = Person.model_validate(value)
    if person.name is not None:
        _validate_text(person.name, "important_people.name")
    _validate_text(person.relationship, "important_people.relationship")
    _validate_text(person.description, "important_people.description")


def _replace_person(input_people, current_people, target, new_person) -> list:
    """只替换唯一匹配的旧人物，其他人物保持原样。"""
    _validate_person(target)
    if not isinstance(input_people, list) or input_people.count(target) != 1:
        raise ValueError("important_people：target 必须唯一匹配输入画像中的一个旧人物")
    if not isinstance(current_people, list) or current_people.count(target) != 1:
        raise ValueError("important_people：本批前面的操作已改变旧人物，不能再次 replace")

    target_index = current_people.index(target)
    for index, person in enumerate(current_people):
        if index != target_index and person == new_person:
            raise ValueError("important_people：替换后会与另一个人物重复，不能自动合并")

    current_people[target_index] = new_person
    return current_people


def _remove_duplicates(items: list) -> list:
    """按原顺序去重，也支持人物对象数组。"""
    unique_items = []
    for item in items:
        if item not in unique_items:
            unique_items.append(item)
    return unique_items

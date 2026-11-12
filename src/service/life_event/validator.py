"""校验经历归纳建议的基本字段及输入中的目标经历。"""

from .schema import LifeEventSuggestion


def validate_life_event_suggestion(
    result: dict, existing_events: list[dict],
) -> LifeEventSuggestion:
    """返回通过基本校验的建议；数据库保存时仍需检查目标用户归属。"""
    suggestion = LifeEventSuggestion.model_validate(result)
    if not suggestion.reason.strip():
        raise ValueError("人生经历归纳建议的 reason 不能为空")

    if suggestion.action == "skip":
        fields = ("event_id", "title", "summary", "life_stage", "time_text", "status")
        if any(getattr(suggestion, field) is not None for field in fields):
            raise ValueError("skip 的经历字段必须全部为 null")
        return suggestion

    if suggestion.action == "create":
        if suggestion.event_id is not None:
            raise ValueError("create 的 event_id 必须为 null")
    elif suggestion.event_id is None or suggestion.event_id <= 0:
        raise ValueError("update 的 event_id 必须为正整数")
    elif suggestion.event_id not in {event["id"] for event in existing_events}:
        raise ValueError("update 的 event_id 必须来自已有经历索引")

    for field in ("title", "summary"):
        value = getattr(suggestion, field)
        if value is None or not value.strip():
            raise ValueError(f"人生经历的 {field} 不能为空")
    if len(suggestion.title) > 200:
        raise ValueError("人生经历的 title 不能超过 200 字")
    if suggestion.life_stage is None or suggestion.status is None:
        raise ValueError("人生经历的 life_stage 和 status 不能为空")
    if suggestion.time_text is not None and (
        not suggestion.time_text.strip() or len(suggestion.time_text) > 100
    ):
        raise ValueError("人生经历的 time_text 必须为 null 或 100 字以内的非空文字")
    return suggestion

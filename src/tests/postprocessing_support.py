"""为数据库集成测试提供离线访后处理模型。"""

import json
from unittest.mock import Mock


def biography_reply(messages, **_kwargs):
    """离线融合器保留旧稿和本次故事，供非模型质量测试使用。"""
    supplied = json.loads(messages[-1][1])
    body = "\n\n".join(part for part in (
        supplied["existing_biography"], supplied["story"]["body"],
    ) if part)
    return json.dumps({"body": body}, ensure_ascii=False)


def stub_postprocessing(monkeypatch):
    """默认不新增画像或经历，避免无关 API 测试调用真实模型。"""
    profile_model = Mock(return_value=json.dumps({"updates": [], "reviews": []}))
    event_model = Mock(return_value=json.dumps({
        "action": "skip", "event_id": None, "title": None, "summary": None,
        "life_stage": None, "time_text": None, "status": None,
        "reason": "离线测试不新增经历索引。",
    }, ensure_ascii=False))
    monkeypatch.setattr("src.service.profile.extractor.call_qwen", profile_model)
    monkeypatch.setattr("src.service.life_event.extractor.call_qwen", event_model)
    monkeypatch.setattr("src.service.biography.service.call_qwen", Mock(side_effect=biography_reply))
    return profile_model, event_model

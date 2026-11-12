"""人生经历索引及模型归纳建议的数据模型。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class LifeEventSuggestion(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    action: Literal["create", "update", "skip"]
    event_id: int | None
    title: str | None
    summary: str | None
    life_stage: Literal["童年", "少年", "青年", "中年", "晚年", "未知"] | None
    time_text: str | None
    status: Literal["told", "expandable"] | None
    reason: str

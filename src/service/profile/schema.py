"""用户画像及更新建议的数据模型。"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


FIELD_TYPES = {
    "basic_background.birth_year": int,
    "basic_background.birth_period": str,
    "basic_background.birthplace": str,
    "basic_background.growth_location": str,
    "basic_background.current_location": str,
    "basic_background.living_background": str,
    "family_background.family_origin": str,
    "family_background.parents_background": str,
    "family_background.siblings_count": int,
    "family_background.childhood_economy": str,
    "family_background.growth_environment": str,
    "education_career.education_level": str,
    "education_career.education_background": str,
    "education_career.main_occupation": str,
    "education_career.work_fields": list,
    "education_career.career_background": str,
    "important_people": list,
    "personal_life.interests": list,
    "personal_life.long_term_habits": list,
}


class Person(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    name: str | None
    relationship: str
    description: str


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    field: str
    operation: Literal["set", "append", "replace"]
    target: Any
    value: Any
    evidence: str
    source_message_ids: list[str]
    context_message_ids: list[str]


class ProfileReview(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    field: str
    existing_value: Any
    new_value: Any
    reason: str
    evidence: str
    source_message_ids: list[str]
    context_message_ids: list[str]


class ProfileExtraction(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    updates: list[ProfileUpdate]
    reviews: list[ProfileReview]

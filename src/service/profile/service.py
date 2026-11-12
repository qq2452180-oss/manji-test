"""读取访谈、提取更新建议，并合并保存用户画像。"""

from ..interview.repository import InterviewSessionRepository
from ...common.dialogue.message_ids import message_id_text
from . import extractor, validator
from .repository import ProfileRepository


class ProfileService:
    def __init__(
        self, repository: ProfileRepository, interviews: InterviewSessionRepository,
    ) -> None:
        self._repository = repository
        self._interviews = interviews

    def get_profile(self, user_id: int) -> dict:
        """返回当前画像，没有记录时使用空画像。"""
        return self._repository.get_profile(user_id) or {}

    def get_session_messages(self, user_id: int, session_id: int | str) -> list[dict]:
        """按保存顺序返回原始对话，只转换提示词需要的三个字段。"""
        session = self._interviews.get(user_id, int(session_id))
        if session is None:
            return []

        roles = {"ai": "assistant", "human": "user"}
        messages = []
        for message in session["context"]:
            if message["type"] not in roles:
                continue

            data = message["data"]
            messages.append({
                "message_id": message_id_text(data.get("id")),
                "role": roles[message["type"]],
                "content": data["content"],
            })

        return messages

    def return_profile_input(self, user_id: int, session_id: int | str) -> dict:
        """返回 user_profile 提示词要求的完整输入。"""
        return {
            "current_profile": self.get_profile(user_id),
            "session_id": str(session_id),
            "messages": self.get_session_messages(user_id, session_id),
        }

    def extract_profile_updates(self, user_id: int, session_id: int | str) -> dict:
        """读取本次提取所需的数据，返回模型给出的画像更新建议。"""
        profile_input = self.return_profile_input(user_id, session_id)
        return extractor.extract_profile_updates(profile_input)

    def update_profile(
        self, user_id: int, session_id: int | str, *, story_id: int | None = None,
        revision_id: int | None = None,
    ) -> dict:
        """提取并保存本次访谈带来的画像变化，同时返回待核实建议。"""
        profile_input = self.return_profile_input(user_id, session_id)
        suggestions = extractor.extract_profile_updates(profile_input)
        result = validator.apply_profile_updates(
            profile_input["current_profile"], suggestions, profile_input["messages"],
        )

        if revision_id is not None or story_id is not None or result["profile"] != profile_input["current_profile"]:
            save_options = {"expected_profile": profile_input["current_profile"]}
            if story_id is not None:
                save_options["story_id"] = story_id
            if revision_id is not None:
                save_options["revision_id"] = revision_id
            result["profile"] = self._repository.save_profile(
                user_id, result["profile"], **save_options,
            )

        return result

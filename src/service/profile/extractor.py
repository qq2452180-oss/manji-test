"""调用 LLM 提取用户画像更新建议。"""

import json

from ...langgraph.llm import call_qwen
from ...langgraph.prompt import load_profile_updater_system_prompt


def extract_profile_updates(profile_input: dict) -> dict:
    """将提示词与结构化输入交给模型，返回待校验的更新建议。"""
    request = [
        ("system", load_profile_updater_system_prompt()),
        ("user", json.dumps(profile_input, ensure_ascii=False)),
    ]
    response = call_qwen(request, json_output=True)
    return json.loads(response)

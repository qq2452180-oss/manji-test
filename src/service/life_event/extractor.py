"""调用 LLM 提取人生经历索引的创建、更新或跳过建议。"""

import json

from ...langgraph.llm import call_qwen
from ...langgraph.prompt import load_life_event_extraction_system_prompt


def extract_life_event_updates(life_event_input: dict) -> dict:
    """将提示词与结构化输入交给模型，返回待校验的归纳建议。"""
    request = [
        ("system", load_life_event_extraction_system_prompt()),
        ("user", json.dumps(life_event_input, ensure_ascii=False)),
    ]
    response = call_qwen(request, json_output=True)
    result = json.loads(response)
    if not isinstance(result, dict):
        raise ValueError("人生经历归纳结果必须是 JSON 对象")
    return result

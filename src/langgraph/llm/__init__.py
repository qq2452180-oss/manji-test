"""LangGraph 节点使用的模型调用入口。"""

from .qwen import call_qwen, call_qwen_thinking

__all__ = ["call_qwen", "call_qwen_thinking"]

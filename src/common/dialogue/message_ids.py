"""会话内递增消息编号；数据库存 BIGINT 范围整数，LangChain 和接口使用十进制字符串。"""

from copy import deepcopy

from langchain_core.messages import BaseMessage, messages_from_dict, messages_to_dict


MAX_MESSAGE_ID = 2**63 - 1


def bigint_message_id(value: int | str) -> int:
    """拒绝 UUID、布尔值、非整数及超出 PostgreSQL BIGINT 范围的编号。"""
    if type(value) is int:
        number = value
    elif isinstance(value, str) and value.isascii() and value.isdecimal() and len(value) <= 19:
        number = int(value)
        if str(number) != value:
            raise ValueError("消息编号必须是规范的正整数")
    else:
        raise ValueError("消息编号必须是正整数，不能使用 UUID")
    if not 0 < number <= MAX_MESSAGE_ID:
        raise ValueError("消息编号超出 BIGINT 范围")
    return number


def message_id_text(value):
    """兼容只读旧上下文；新保存的编号由 bigint_message_id 严格校验。"""
    return str(bigint_message_id(value)) if type(value) is int else value


def next_message_id(messages: list[BaseMessage]) -> str:
    """会话锁保护下，分配大于已有整数消息编号的新编号。"""
    numbers = [
        bigint_message_id(message.id) for message in messages
        if message.id is not None and message.id.isascii() and message.id.isdecimal()
    ]
    return str(bigint_message_id(max(numbers, default=0) + 1))


def messages_to_context(messages: list[BaseMessage]) -> list[dict]:
    """只转换编号的存储类型，保留消息正文和其余元数据。"""
    context = deepcopy(messages_to_dict(messages))
    ids = [bigint_message_id(message["data"]["id"]) for message in context]
    if len(set(ids)) != len(ids):
        raise ValueError("会话消息编号重复")
    for message, message_id in zip(context, ids):
        data = message["data"]
        data["id"] = message_id
        metadata = data.get("additional_kwargs", {})
        if metadata.get("source_message_id") is not None:
            source_id = bigint_message_id(metadata["source_message_id"])
            if source_id not in ids:
                raise ValueError("来源消息编号不在当前会话中")
            metadata["source_message_id"] = source_id
    return context


def messages_from_context(context: list[dict]) -> list[BaseMessage]:
    """恢复数值编号及其引用；避免元数据中的整数与 LangChain 字符串比较失败。"""
    restored = deepcopy(context)
    for message in restored:
        data = message["data"]
        data["id"] = message_id_text(data.get("id"))
        metadata = data.get("additional_kwargs", {})
        if metadata.get("source_message_id") is not None:
            metadata["source_message_id"] = message_id_text(metadata["source_message_id"])
    messages = messages_from_dict(restored)
    # 兼容没有编号的旧开场；提前赋数值 ID，阻止 reducer 再补 UUID。
    for message in messages:
        if message.id is None:
            message.id = next_message_id(messages)
    return messages

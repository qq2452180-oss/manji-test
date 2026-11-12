"""Provider-neutral image inputs and failures shared by dialogue adapters."""

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelImage:
    media_id: str
    image_bytes: bytes
    mime_type: str


class DialogueModelError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


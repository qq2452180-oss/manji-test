"""检查图片、保存文件和 media 记录，再按用户及会话读取图片。"""

import struct
import uuid
import warnings
from io import BytesIO
from typing import BinaryIO

from PIL import Image, UnidentifiedImageError
import psycopg

from .errors import (
    MediaEmptyError, MediaInvalidImageError, MediaNotFoundError,
    MediaStorageError, MediaTooLargeError, MediaUnsupportedError,
)
from .repository import MediaRepository
from .storage import LocalMediaStorage


_FORMATS = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "WEBP": ("image/webp", "webp"),
}
_MIME_TYPES = {extension: mime_type for mime_type, extension in _FORMATS.values()}


def _inspect_image(data: bytes, max_pixels: int) -> str:
    """检查图片是否可用，只返回保存文件所需的扩展名。"""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format not in _FORMATS:
                    raise MediaUnsupportedError("只支持 JPEG、PNG 或 WebP 照片")
                width, height = image.size
                if width * height > max_pixels:
                    raise MediaTooLargeError("照片像素过大，请缩小后上传")
                if getattr(image, "is_animated", False) or getattr(image, "n_frames", 1) != 1:
                    raise MediaUnsupportedError("暂不支持动画图片，请选择静态照片")
                _, extension = _FORMATS[image.format]
                image.verify()
            # verify 检查容器后重新解码，避免保存截断或损坏的图片。
            with Image.open(BytesIO(data)) as image:
                image.load()
            return extension
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise MediaTooLargeError("照片像素过大，请缩小后上传") from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError, struct.error) as exc:
        raise MediaInvalidImageError("照片格式无效或文件已损坏，请重新选择") from exc


class MediaService:
    def __init__(
        self, repository: MediaRepository, storage: LocalMediaStorage,
        *, max_bytes: int = 10 * 1024 * 1024, max_pixels: int = 50_000_000,
    ) -> None:
        self._repository = repository
        self._storage = storage
        self._max_bytes = max_bytes
        self._max_pixels = max_pixels

    def upload(self, user_id: int, session_id: str, stream: BinaryIO) -> int:
        """保存图片和媒体记录，只返回后续访谈需要的图片 ID。"""
        chunks = []
        size = 0
        try:
            while size <= self._max_bytes:
                chunk = stream.read(min(65_536, self._max_bytes + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                chunks.append(chunk)
        except (OSError, ValueError) as exc:
            raise MediaStorageError("读取上传照片失败，请重试") from exc
        if size > self._max_bytes:
            raise MediaTooLargeError("照片文件过大，请选择较小的照片")
        if not size:
            raise MediaEmptyError("照片文件不能为空")

        data = b"".join(chunks)
        extension = _inspect_image(data, self._max_pixels)
        file_path = f"{uuid.uuid4().hex}.{extension}"
        self._storage.save(file_path, data)
        try:
            media_id = self._repository.create(user_id, session_id, file_path)
        except Exception as exc:
            try:
                self._storage.delete(file_path)
            except MediaStorageError as cleanup_error:
                raise MediaStorageError("照片信息保存失败，文件清理失败") from cleanup_error
            raise MediaStorageError("照片信息保存失败，请重试") from exc
        return media_id

    def read(self, user_id: int, session_id: str, media_id: int) -> tuple[bytes, str]:
        try:
            asset = self._repository.get(user_id, session_id, media_id)
        except psycopg.Error as exc:
            raise MediaStorageError("照片信息读取失败，请重试") from exc
        if asset is None:
            raise MediaNotFoundError("照片不存在")
        data = self._storage.read(asset["file_path"])
        mime_type = _MIME_TYPES[asset["file_path"].rsplit(".", 1)[1]]
        return data, mime_type


__all__ = ["MediaService"]

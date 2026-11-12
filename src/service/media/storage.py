"""Atomic private file storage with opaque, single-component storage keys."""

from __future__ import annotations

import os
import re
import stat
import uuid
from contextlib import contextmanager
from pathlib import Path

from .errors import MediaNotFoundError, MediaStorageError


_KEY = re.compile(r"[0-9a-f]{32}\.(?:jpg|png|webp)\Z")
_WEB_ROOT = Path(__file__).resolve().parents[3] / "web"


class LocalMediaStorage:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser().resolve()
        public_root = _WEB_ROOT.resolve()
        if self.root == public_root or public_root in self.root.parents:
            raise ValueError("MEDIA_STORAGE_DIR must not be inside the public web directory")
        try:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not self.root.is_dir():
                raise MediaStorageError("照片存储目录不可用")
        except OSError as exc:
            raise MediaStorageError("照片存储目录不可用") from exc

    @contextmanager
    def _directory(self):
        try:
            # A symlink substituted for the configured root is never followed.
            # dir_fd operations then stay anchored to the opened directory.
            if self.root.resolve() != self.root:
                raise MediaStorageError("照片存储目录不可用")
            directory_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError as exc:
            raise MediaStorageError("照片存储目录不可用") from exc
        try:
            yield directory_fd
        finally:
            os.close(directory_fd)

    @staticmethod
    def _validate_key(storage_key: str) -> None:
        if not _KEY.fullmatch(storage_key):
            raise MediaStorageError("照片存储标识无效")

    def save(self, storage_key: str, data: bytes) -> None:
        self._validate_key(storage_key)
        temporary_key = f".upload-{uuid.uuid4().hex}"
        with self._directory() as directory_fd:
            published = False
            try:
                file_fd = os.open(
                    temporary_key,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=directory_fd,
                )
                with os.fdopen(file_fd, "wb") as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                # Hard-link publication is atomic and cannot overwrite an
                # existing asset (or follow a planted destination symlink).
                os.link(
                    temporary_key, storage_key,
                    src_dir_fd=directory_fd, dst_dir_fd=directory_fd,
                    follow_symlinks=False,
                )
                published = True
                os.unlink(temporary_key, dir_fd=directory_fd)
                os.fsync(directory_fd)
            except OSError as exc:
                for key in (temporary_key, storage_key) if published else (temporary_key,):
                    try:
                        os.unlink(key, dir_fd=directory_fd)
                    except FileNotFoundError:
                        pass
                    except OSError:
                        # Preserve the original failure; no asset metadata is
                        # created when save fails, so leftovers are not readable.
                        pass
                raise MediaStorageError("照片文件保存失败，请重试") from exc

    def read(self, storage_key: str) -> bytes:
        self._validate_key(storage_key)
        with self._directory() as directory_fd:
            try:
                file_fd = os.open(
                    storage_key, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                    dir_fd=directory_fd,
                )
                with os.fdopen(file_fd, "rb") as source:
                    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                        raise MediaStorageError("照片文件不可读")
                    return source.read()
            except FileNotFoundError as exc:
                raise MediaNotFoundError("照片不存在") from exc
            except OSError as exc:
                raise MediaStorageError("读取照片文件失败，请重试") from exc

    def delete(self, storage_key: str) -> None:
        self._validate_key(storage_key)
        with self._directory() as directory_fd:
            try:
                # unlink never follows a symlink to a file outside this root.
                os.unlink(storage_key, dir_fd=directory_fd)
                os.fsync(directory_fd)
            except FileNotFoundError:
                return
            except OSError as exc:
                raise MediaStorageError("照片文件清理失败") from exc


__all__ = ["LocalMediaStorage"]

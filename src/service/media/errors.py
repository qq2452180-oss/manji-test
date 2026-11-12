"""Media-domain failures shared by the service and its adapters."""


class MediaError(RuntimeError):
    """Base class for failures safe for the API to classify."""


class MediaEmptyError(MediaError):
    pass


class MediaUnsupportedError(MediaError):
    pass


class MediaInvalidImageError(MediaError):
    pass


class MediaTooLargeError(MediaError):
    pass


class MediaNotFoundError(MediaError):
    pass


class MediaStorageError(MediaError):
    pass


__all__ = [
    "MediaEmptyError", "MediaError", "MediaInvalidImageError",
    "MediaNotFoundError", "MediaStorageError", "MediaTooLargeError",
    "MediaUnsupportedError",
]

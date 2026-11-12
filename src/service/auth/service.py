"""从旧登录模块精简迁移的用户名规则、密码校验与随机凭证。"""

import hashlib
import re
import secrets

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError
import psycopg

from .repository import AuthRepository


_HASHER = PasswordHasher(
    time_cost=2, memory_cost=19456, parallelism=1,
    hash_len=32, salt_len=16, type=Type.ID,
)
_DUMMY_HASH = _HASHER.hash(secrets.token_urlsafe(32))


class AuthError(ValueError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def _normalize_credentials(username: str, password: str) -> tuple[str, str]:
    if not isinstance(username, str) or re.fullmatch(r"[a-z0-9_]{3,32}", username.strip().lower()) is None:
        raise AuthError("账号需为 3 至 32 位字母、数字或下划线", 422)
    if not isinstance(password, str) or not password:
        raise AuthError("请输入密码", 422)
    # 密码中的空格和其他字符都是密码的一部分。
    return username.strip().lower(), password


def _verify_password(encoded: str | None, password: str) -> bool:
    try:
        matched = _HASHER.verify(encoded or _DUMMY_HASH, password)
    except (VerificationError, InvalidHashError):
        return False
    return encoded is not None and matched


def _token_hash(token: str) -> str:
    if not isinstance(token, str) or re.fullmatch(r"[A-Za-z0-9_-]{43}", token) is None:
        raise AuthError("请重新登录", 401)
    return hashlib.sha256(token.encode("ascii")).hexdigest()


class AuthService:
    def __init__(self, repository: AuthRepository) -> None:
        self._repository = repository

    def register(self, username: str, password: str, guest_token: str | None = None) -> dict:
        username, password = _normalize_credentials(username, password)
        try:
            if guest_token is not None:
                user = self.get_user(guest_token)
                if not user["is_guest"]:
                    raise AuthError("当前账号已注册，请直接登录", 409)
                upgraded = self._repository.upgrade_guest(
                    _token_hash(guest_token), username, _HASHER.hash(password),
                )
                if upgraded is None:
                    raise AuthError("体验身份已变化，请重新登录", 401)
                return upgraded
            return self._repository.create_user(username, _HASHER.hash(password))
        except psycopg.errors.UniqueViolation:
            raise AuthError("这个账号已被使用，请换一个", 409) from None
        except psycopg.Error:
            raise AuthError("账号暂时无法保存，请稍后重试", 503) from None

    def start_guest(self) -> dict:
        """一次事务创建游客与随机凭据；占位账号不能通过密码登录规则。"""
        token = secrets.token_urlsafe(32)
        try:
            user = self._repository.create_guest(
                "guest:" + secrets.token_hex(16),
                _HASHER.hash(secrets.token_urlsafe(32)), _token_hash(token),
            )
            return {"token": token, "user": user}
        except psycopg.Error:
            raise AuthError("体验暂时无法开始，请稍后重试", 503) from None

    def login(self, username: str, password: str) -> dict:
        username, password = _normalize_credentials(username, password)
        try:
            user = self._repository.find_by_username(username)
            if not _verify_password(user["password"] if user else None, password):
                raise AuthError("账号或密码不正确", 401)
            token = secrets.token_urlsafe(32)
            token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
            user = self._repository.update_token(user["id"], token_hash)
            if user is None:
                raise AuthError("账号或密码不正确", 401)
            return {"token": token, "user": user}
        except psycopg.Error:
            raise AuthError("登录暂时不可用，请稍后重试", 503) from None

    def get_user_id(self, token: str) -> int:
        token_hash = _token_hash(token)
        try:
            user_id = self._repository.find_user_id_by_token(token_hash)
        except psycopg.Error:
            raise AuthError("登录验证暂时不可用，请稍后重试", 503) from None
        if user_id is None:
            raise AuthError("请重新登录", 401)
        return user_id

    def get_user(self, token: str) -> dict:
        token_hash = _token_hash(token)
        try:
            user = self._repository.find_user_by_token(token_hash)
        except psycopg.Error:
            raise AuthError("登录验证暂时不可用，请稍后重试", 503) from None
        if user is None:
            raise AuthError("请重新登录", 401)
        return user

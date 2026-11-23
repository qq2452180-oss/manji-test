"""手机号验证码登录；腾讯云负责投递，验证码由本服务签发及校验。"""

import hmac
import re
import secrets

import psycopg

from ...common.tencent_sms import SmsDeliveryError, TencentSmsSender
from .repository import AuthRepository
from .service import AuthError, generate_unusable_password_hash, issue_login_token
from .sms_codes import SMS_CODE_TTL_SECONDS, SMS_RESEND_SECONDS, SmsCodeStore


def _normalize_phone(phone: str) -> str:
    match = re.fullmatch(r"(?:\+86)?(1[3-9][0-9]{9})", phone.strip())
    if match is None:
        raise AuthError("请输入有效的中国大陆手机号", 422)
    return "+86" + match[1]


class SmsAuthService:
    def __init__(
        self, repository: AuthRepository, sender: TencentSmsSender | None, *, codes: SmsCodeStore | None = None,
    ) -> None:
        self._repository = repository
        self._sender = sender
        self._codes = codes if codes is not None else SmsCodeStore()
        self._code_secret = secrets.token_bytes(32)

    def _digest(self, message: str) -> bytes:
        return hmac.digest(self._code_secret, message.encode("utf-8"), "sha256")

    def send_code(self, phone: str, client_ip: str) -> dict:
        phone = _normalize_phone(phone)
        if self._sender is None:
            raise AuthError("短信登录暂时不可用，请稍后再试", 503)
        reservation = self._codes.reserve(phone, self._digest(f"ip:{client_ip}").hex())
        if reservation is None:
            raise AuthError("验证码请求过于频繁，请稍后再试", 429)
        code = f"{secrets.randbelow(1_000_000):06d}"
        try:
            self._sender.send_code(phone, code, valid_minutes=SMS_CODE_TTL_SECONDS // 60)
        except SmsDeliveryError:
            self._codes.finish(phone, reservation, None)
            raise AuthError("验证码发送失败，请稍后再试", 503) from None
        if not self._codes.finish(phone, reservation, self._digest(f"login:{phone}:{code}")):
            raise AuthError("本次验证码已失效，请稍后重新获取", 409)
        return {"expires_in": SMS_CODE_TTL_SECONDS, "retry_after": SMS_RESEND_SECONDS}

    def login(self, phone: str, code: str) -> dict:
        phone = _normalize_phone(phone)
        if re.fullmatch(r"[0-9]{6}", code) is None:
            raise AuthError("请输入六位数字验证码", 422)
        claim = self._codes.claim(phone, self._digest(f"login:{phone}:{code}"))
        if claim is None:
            raise AuthError("验证码错误或已失效，请重新确认", 400)
        token, token_hash = issue_login_token()
        # 内部用户名不能通过旧用户名规则登录，也不暴露用户的手机号。
        username = "sms:" + secrets.token_hex(16)
        try:
            user = self._repository.login_with_verified_phone(
                phone, username, generate_unusable_password_hash(), token_hash,
            )
        except psycopg.Error as exc:
            # 约束冲突、序列化失败或死锁时事务已回滚。连接中断时提交结果可能未知。
            if isinstance(exc, psycopg.IntegrityError) or exc.sqlstate in {"40001", "40P01"}:
                self._codes.restore(phone, claim)
                raise AuthError("短信登录暂时不可用，请稍后再试", 503) from None
            self._codes.discard(phone, claim)
            raise AuthError("短信登录暂时不可用，请稍后重新获取验证码", 503) from None
        self._codes.discard(phone, claim)
        return {"token": token, "user": user}

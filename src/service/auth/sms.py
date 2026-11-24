"""手机号验证码登录；腾讯云负责投递，验证码由本服务签发及校验。"""

import hmac
import re
import secrets

import psycopg

from ...common.tencent_sms import SmsDeliveryError, TencentSmsSender
from .captcha import render_captcha
from .repository import AuthRepository
from .service import AuthError, generate_unusable_password_hash, issue_login_token
from .sms_codes import SMS_CODE_TTL_SECONDS, SmsCaptcha, SmsCodeStore, SmsRateLimit


_LIMIT_MESSAGES = {
    "SMS_COOLDOWN": "验证码请求过于频繁，请稍后再试",
    "SMS_PHONE_LIMIT": "该手机号已达 24 小时发送上限，请稍后再试",
    "SMS_IP_LIMIT": "当前网络已达 24 小时发送上限，请稍后再试",
}


class SmsSendError(AuthError):
    def __init__(
        self, message: str, status_code: int, code: str, retry_after: int | None = None,
        rate_limit_code: str | None = None, *, captcha: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message, status_code)
        self.code = code
        self.retry_after = retry_after
        self.rate_limit_code = rate_limit_code
        self.captcha = captcha


def _captcha_response(challenge: SmsCaptcha) -> dict[str, str]:
    return {"id": challenge.id, "image": render_captcha(challenge.answer)}


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

    def _send_keys(self, phone: str, client_ip: str) -> tuple[str, str]:
        phone = _normalize_phone(phone)
        if self._sender is None:
            raise AuthError("短信登录暂时不可用，请稍后再试", 503)
        return phone, self._digest(f"ip:{client_ip}").hex()

    def refresh_captcha(self, phone: str, client_ip: str) -> dict[str, str]:
        phone, ip_key = self._send_keys(phone, client_ip)
        result = self._codes.refresh_captcha(phone, ip_key)
        if isinstance(result, SmsRateLimit):
            raise SmsSendError(_LIMIT_MESSAGES[result.code], 429, result.code, result.retry_after)
        if result is None:
            raise SmsSendError("当前可直接获取短信验证码。", 409, "SMS_CAPTCHA_NOT_REQUIRED")
        return _captcha_response(result)

    def send_code(
        self, phone: str, client_ip: str, *, captcha_id: str | None = None, captcha_answer: str | None = None,
    ) -> dict:
        phone, ip_key = self._send_keys(phone, client_ip)
        reservation = self._codes.reserve(phone, ip_key, captcha_id=captcha_id, captcha_answer=captcha_answer)
        if isinstance(reservation, SmsRateLimit):
            raise SmsSendError(_LIMIT_MESSAGES[reservation.code], 429, reservation.code, reservation.retry_after)
        if isinstance(reservation, SmsCaptcha):
            message = ("请输入图中的 4 位数字，再获取短信验证码。" if reservation.code == "SMS_CAPTCHA_REQUIRED"
                       else "图片验证码有误或已过期，请输入新图片中的数字。")
            raise SmsSendError(message, 400, reservation.code, captcha=_captcha_response(reservation))
        code = f"{secrets.randbelow(1_000_000):06d}"
        try:
            self._sender.send_code(phone, code, valid_minutes=SMS_CODE_TTL_SECONDS // 60)
        except SmsDeliveryError:
            self._codes.finish(phone, reservation, None)
            limit = self._codes.rate_limit(phone, ip_key)
            raise SmsSendError(
                "验证码发送失败，请稍后再试", 503, "SMS_DELIVERY_FAILED",
                limit.retry_after if limit else 0, limit.code if limit else None,
            ) from None
        if not self._codes.finish(phone, reservation, self._digest(f"login:{phone}:{code}")):
            raise AuthError("本次验证码已失效，请稍后重新获取", 409)
        limit = self._codes.rate_limit(phone, ip_key)
        response = {"expires_in": SMS_CODE_TTL_SECONDS, "retry_after": limit.retry_after if limit else 0}
        if limit and limit.code != "SMS_COOLDOWN":
            response["rate_limit_code"] = limit.code
        return response

    def login(self, phone: str, code: str, *, browser: bool = False) -> dict:
        phone = _normalize_phone(phone)
        if re.fullmatch(r"[0-9]{6}", code) is None:
            raise AuthError("请输入六位数字验证码", 422)
        claim = self._codes.claim(phone, self._digest(f"login:{phone}:{code}"))
        if claim is None:
            raise AuthError("验证码错误或已失效，请重新确认", 400)
        token, token_hash = issue_login_token(browser=browser)
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

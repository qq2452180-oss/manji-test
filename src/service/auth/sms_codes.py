"""登录验证码和发送频率记录，随单个应用进程一起创建和释放。"""

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
import hmac
from math import ceil
import secrets
from threading import Lock
from time import monotonic


SMS_CODE_TTL_SECONDS = 300
SMS_RESEND_SECONDS = 60
SMS_CAPTCHA_WINDOW_SECONDS = 10 * 60
SMS_CAPTCHA_TTL_SECONDS = 120
_DAY = 24 * 60 * 60
_PHONE_DAILY_LIMIT = 10
_IP_DAILY_LIMIT = 30
_MAX_WRONG_ATTEMPTS = 5


@dataclass(eq=False, slots=True)
class _Reservation:
    expires_at: float


@dataclass(frozen=True, slots=True)
class SmsRateLimit:
    code: str
    retry_after: int


@dataclass(frozen=True, slots=True)
class SmsCaptcha:
    id: str
    answer: str = field(repr=False)
    code: str


@dataclass(slots=True)
class _StoredCaptcha:
    id: str
    digest: bytes
    expires_at: float


@dataclass(slots=True)
class _Code:
    digest: bytes
    expires_at: float
    wrong_attempts: int = 0
    claim: object | None = None


class SmsCodeStore:
    def __init__(self, clock: Callable[[], float] = monotonic) -> None:
        self._clock = clock
        self._lock = Lock()
        self._captcha_secret = secrets.token_bytes(32)
        self._captchas: dict[str, _StoredCaptcha] = {}
        self._pending: dict[str, _Reservation] = {}
        self._codes: dict[str, _Code] = {}
        self._expirations: deque[tuple[float, str]] = deque()
        self._sends: deque[tuple[float, str, str]] = deque()
        self._phone_sends: dict[str, deque[float]] = {}
        self._ip_sends: dict[str, deque[float]] = {}

    def _purge_expired(self, now: float) -> None:
        # 固定时长和单调时钟保证两个队列各自按过期时间排列。
        while self._expirations and self._expirations[0][0] <= now:
            _, phone = self._expirations.popleft()
            pending = self._pending.get(phone)
            if pending and pending.expires_at <= now:
                del self._pending[phone]
            code = self._codes.get(phone)
            if code and code.expires_at <= now:
                del self._codes[phone]

        while self._sends and self._sends[0][0] <= now - _DAY:
            _, phone, ip_key = self._sends.popleft()
            times = self._phone_sends[phone]
            times.popleft()
            if not times:
                del self._phone_sends[phone]
                self._captchas.pop(phone, None)
            ip_times = self._ip_sends[ip_key]
            ip_times.popleft()
            if not ip_times:
                del self._ip_sends[ip_key]

    def _rate_limit(self, phone: str, ip_key: str, now: float) -> SmsRateLimit | None:
        deadlines = []
        phone_times = self._phone_sends.get(phone)
        if phone_times and len(phone_times) >= _PHONE_DAILY_LIMIT:
            deadlines.append((phone_times[0] + _DAY, "SMS_PHONE_LIMIT"))
        ip_times = self._ip_sends.get(ip_key)
        if ip_times and len(ip_times) >= _IP_DAILY_LIMIT:
            deadlines.append((ip_times[0] + _DAY, "SMS_IP_LIMIT"))
        if phone_times:
            deadlines.append((phone_times[-1] + SMS_RESEND_SECONDS, "SMS_COOLDOWN"))
        if not deadlines:
            return None
        # 多个限制同时生效时，所有窗口都解除后才能再次发送。
        until, code = max(deadlines, key=lambda item: item[0])
        return SmsRateLimit(code, ceil(until - now)) if until > now else None

    def rate_limit(self, phone: str, ip_key: str) -> SmsRateLimit | None:
        with self._lock:
            now = self._clock()
            self._purge_expired(now)
            return self._rate_limit(phone, ip_key, now)

    def _needs_captcha(self, phone: str, now: float) -> bool:
        times = self._phone_sends.get(phone)
        return times is not None and len(times) >= 2 and times[-2] > now - SMS_CAPTCHA_WINDOW_SECONDS

    def _captcha_digest(self, captcha_id: str, answer: str) -> bytes:
        return hmac.digest(self._captcha_secret, (captcha_id + ":" + answer).encode("utf-8"), "sha256")

    def _new_captcha(self, phone: str, now: float, code: str) -> SmsCaptcha:
        captcha = SmsCaptcha(secrets.token_urlsafe(24), f"{secrets.randbelow(10_000):04d}", code)
        self._captchas[phone] = _StoredCaptcha(
            captcha.id, self._captcha_digest(captcha.id, captcha.answer), now + SMS_CAPTCHA_TTL_SECONDS,
        )
        return captcha

    def refresh_captcha(self, phone: str, ip_key: str) -> SmsCaptcha | SmsRateLimit | None:
        with self._lock:
            now = self._clock()
            self._purge_expired(now)
            limit = self._rate_limit(phone, ip_key, now)
            if limit:
                return limit
            if not self._needs_captcha(phone, now):
                self._captchas.pop(phone, None)
                return None
            return self._new_captcha(phone, now, "SMS_CAPTCHA_REQUIRED")

    def reserve(
        self, phone: str, ip_key: str, captcha_id: str | None = None, captcha_answer: str | None = None,
    ) -> _Reservation | SmsRateLimit | SmsCaptcha:
        with self._lock:
            now = self._clock()
            self._purge_expired(now)
            limit = self._rate_limit(phone, ip_key, now)
            if limit:
                return limit
            if self._needs_captcha(phone, now):
                if captcha_id is None and captcha_answer is None:
                    return self._new_captcha(phone, now, "SMS_CAPTCHA_REQUIRED")
                saved = self._captchas.get(phone)
                if (saved is None or saved.expires_at <= now or saved.id != captcha_id
                        or not captcha_answer or len(captcha_answer) != 4 or not captcha_answer.isascii()
                        or not hmac.compare_digest(saved.digest, self._captcha_digest(saved.id, captcha_answer))):
                    return self._new_captcha(phone, now, "SMS_CAPTCHA_INVALID")
            # 成功校验与占用发送名额在同一把锁内，一张图片只能放行一次。
            self._captchas.pop(phone, None)
            self._phone_sends.setdefault(phone, deque()).append(now)
            self._ip_sends.setdefault(ip_key, deque()).append(now)
            self._sends.append((now, phone, ip_key))
            reservation = _Reservation(now + SMS_CODE_TTL_SECONDS)
            self._pending[phone] = reservation
            self._expirations.append((reservation.expires_at, phone))
            return reservation

    def finish(self, phone: str, reservation: _Reservation, digest: bytes | None) -> bool:
        """只有最新且仍有效的发送请求可以替换已送达的码。"""
        with self._lock:
            now = self._clock()
            self._purge_expired(now)
            if reservation is None or self._pending.get(phone) is not reservation:
                return False
            del self._pending[phone]
            if digest is None:
                return False
            code = _Code(digest, now + SMS_CODE_TTL_SECONDS)
            self._codes[phone] = code
            self._expirations.append((code.expires_at, phone))
            return True

    def claim(self, phone: str, digest: bytes) -> object | None:
        with self._lock:
            self._purge_expired(self._clock())
            code = self._codes.get(phone)
            if code is None or code.claim is not None:
                return None
            if not hmac.compare_digest(code.digest, digest):
                code.wrong_attempts += 1
                if code.wrong_attempts >= _MAX_WRONG_ATTEMPTS:
                    del self._codes[phone]
                return None
            code.claim = object()
            return code.claim

    def restore(self, phone: str, claim: object) -> None:
        """账号事务失败时，仅恢复本次领取的、仍有效的原验证码。"""
        with self._lock:
            self._purge_expired(self._clock())
            code = self._codes.get(phone)
            if code is not None and code.claim is claim:
                code.claim = None

    def discard(self, phone: str, claim: object) -> None:
        with self._lock:
            self._purge_expired(self._clock())
            code = self._codes.get(phone)
            if claim is not None and code is not None and code.claim is claim:
                del self._codes[phone]

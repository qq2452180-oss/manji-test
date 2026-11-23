"""登录验证码和发送频率记录，随单个应用进程一起创建和释放。"""

from collections import Counter, deque
from collections.abc import Callable
from dataclasses import dataclass
import hmac
from threading import Lock
from time import monotonic


SMS_CODE_TTL_SECONDS = 300
SMS_RESEND_SECONDS = 60
_DAY = 24 * 60 * 60
_PHONE_DAILY_LIMIT = 10
_IP_DAILY_LIMIT = 30
_MAX_WRONG_ATTEMPTS = 5


@dataclass(eq=False, slots=True)
class _Reservation:
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
        self._pending: dict[str, _Reservation] = {}
        self._codes: dict[str, _Code] = {}
        self._expirations: deque[tuple[float, str]] = deque()
        self._sends: deque[tuple[float, str, str]] = deque()
        self._phone_sends: dict[str, deque[float]] = {}
        self._ip_counts: Counter[str] = Counter()

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
            self._ip_counts[ip_key] -= 1
            if self._ip_counts[ip_key] == 0:
                del self._ip_counts[ip_key]

    def reserve(self, phone: str, ip_key: str) -> _Reservation | None:
        with self._lock:
            now = self._clock()
            self._purge_expired(now)
            times = self._phone_sends.get(phone)
            if times and (len(times) >= _PHONE_DAILY_LIMIT or now - times[-1] < SMS_RESEND_SECONDS):
                return None
            if self._ip_counts[ip_key] >= _IP_DAILY_LIMIT:
                return None
            self._phone_sends.setdefault(phone, deque()).append(now)
            self._ip_counts[ip_key] += 1
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

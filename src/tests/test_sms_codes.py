"""用可控的单调时钟验证短信的内存生命周期和并发语义。"""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from src.service.auth.sms_codes import SMS_CODE_TTL_SECONDS, SMS_RESEND_SECONDS, SmsCodeStore


class Clock:
    now = 0.0

    def __call__(self):
        return self.now


@pytest.fixture
def memory():
    clock = Clock()
    return SmsCodeStore(clock), clock


def deliver(store, digest):
    pending = store.reserve("phone", "ip")
    assert pending is not None
    assert store.finish("phone", pending, digest)


def test_concurrent_send_and_claim_have_one_winner(memory):
    store, _ = memory
    ready = Barrier(2)

    def reserve(ip):
        ready.wait()
        return store.reserve("phone", ip)

    with ThreadPoolExecutor(max_workers=2) as workers:
        reservations = [value for value in workers.map(reserve, ("ip1", "ip2")) if value is not None]
    assert len(reservations) == 1
    assert store.claim("phone", b"code") is None
    assert store.finish("phone", reservations[0], b"code")

    def claim():
        ready.wait()
        return store.claim("phone", b"code")

    with ThreadPoolExecutor(max_workers=2) as workers:
        requests = [workers.submit(claim) for _ in range(2)]
    assert sum(request.result() is not None for request in requests) == 1


def test_rejected_or_stale_delivery_does_not_replace_the_active_code(memory):
    store, clock = memory
    deliver(store, b"original")
    clock.now += SMS_RESEND_SECONDS
    delayed = store.reserve("phone", "ip")
    clock.now += SMS_RESEND_SECONDS
    rejected = store.reserve("phone", "ip")
    assert not store.finish("phone", delayed, b"delayed")
    assert not store.finish("phone", rejected, None)
    assert not store.finish("phone", rejected, b"late")
    assert store.claim("phone", b"delayed") is None
    assert store.claim("phone", b"original") is not None


def test_only_a_live_claim_can_restore_its_own_code(memory):
    store, clock = memory
    deliver(store, b"first")
    first = store.claim("phone", b"first")
    store.restore("different phone", first)
    store.restore("phone", object())
    assert store.claim("phone", b"first") is None
    store.restore("phone", first)
    second = store.claim("phone", b"first")
    assert second is not None
    store.restore("phone", first)
    assert store.claim("phone", b"first") is None
    clock.now += SMS_RESEND_SECONDS
    deliver(store, b"replacement")
    assert store.claim("phone", b"first") is None
    assert store.claim("phone", b"replacement") is not None
    store.restore("phone", second)
    assert store.claim("phone", b"first") is None
    assert store.claim("phone", b"replacement") is None


def test_expiry_is_enforced_for_pending_active_and_claimed_codes(memory):
    store, clock = memory
    delayed = store.reserve("phone", "ip")
    clock.now += SMS_CODE_TTL_SECONDS
    assert not store.finish("phone", delayed, b"delayed")
    deliver(store, b"active")
    clock.now += SMS_CODE_TTL_SECONDS
    assert store.claim("phone", b"active") is None
    deliver(store, b"claim")
    receipt = store.claim("phone", b"claim")
    assert receipt is not None
    clock.now += SMS_CODE_TTL_SECONDS
    store.restore("phone", receipt)
    assert store.claim("phone", b"claim") is None


def test_discard_only_removes_the_matching_claim_and_prevents_restore(memory):
    store, clock = memory
    deliver(store, b"old")
    first = store.claim("phone", b"old")
    assert first is not None
    clock.now += SMS_RESEND_SECONDS
    deliver(store, b"current")
    store.discard("phone", first)
    current = store.claim("phone", b"current")
    assert current is not None
    store.discard("phone", current)
    store.restore("phone", current)
    assert store.claim("phone", b"current") is None


def test_five_wrong_attempts_invalidate_code(memory):
    store, clock = memory
    deliver(store, b"first")
    for _ in range(4):
        assert store.claim("phone", b"wrong") is None
    assert store.claim("phone", b"first") is not None
    clock.now += SMS_RESEND_SECONDS
    deliver(store, b"next")
    for _ in range(5):
        assert store.claim("phone", b"wrong") is None
    assert store.claim("phone", b"next") is None


def test_rolling_limits_count_failed_attempts_and_release_old_slots(memory):
    store, clock = memory
    for _ in range(10):
        pending = store.reserve("phone", "ip")
        assert pending is not None
        assert not store.finish("phone", pending, None)
        assert store.reserve("phone", "other ip") is None
        clock.now += SMS_RESEND_SECONDS
    assert store.reserve("phone", "other ip") is None
    for i in range(20):
        assert store.reserve(f"phone-{i}", "ip") is not None
    assert store.reserve("another phone", "ip") is None
    clock.now = 24 * 60 * 60
    assert store.reserve("phone", "ip") is not None
    assert store.reserve("another phone", "ip") is None

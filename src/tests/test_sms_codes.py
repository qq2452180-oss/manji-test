"""用可控的单调时钟验证短信的内存生命周期和并发语义。"""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from src.service.auth.sms_codes import (
    SMS_CAPTCHA_TTL_SECONDS, SMS_CAPTCHA_WINDOW_SECONDS, SMS_CODE_TTL_SECONDS, SMS_RESEND_SECONDS,
    SmsCaptcha, SmsCodeStore, SmsRateLimit,
)


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
    assert not isinstance(pending, (SmsRateLimit, SmsCaptcha))
    assert store.finish("phone", pending, digest)


def reserve_with_captcha_if_required(store, phone, ip):
    result = store.reserve(phone, ip)
    if isinstance(result, SmsCaptcha):
        result = store.reserve(phone, ip, result.id, result.answer)
    assert not isinstance(result, (SmsRateLimit, SmsCaptcha))
    return result


def test_concurrent_send_and_claim_have_one_winner(memory):
    store, _ = memory
    ready = Barrier(2)

    def reserve(ip):
        ready.wait()
        return store.reserve("phone", ip)

    with ThreadPoolExecutor(max_workers=2) as workers:
        reservations = [value for value in workers.map(reserve, ("ip1", "ip2")) if not isinstance(value, SmsRateLimit)]
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
    rejected = reserve_with_captcha_if_required(store, "phone", "ip")
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
        pending = reserve_with_captcha_if_required(store, "phone", "ip")
        assert not store.finish("phone", pending, None)
        assert isinstance(store.reserve("phone", "other ip"), SmsRateLimit)
        clock.now += SMS_RESEND_SECONDS
    assert store.reserve("phone", "other ip") == SmsRateLimit("SMS_PHONE_LIMIT", 86400 - 600)
    for i in range(20):
        assert not isinstance(store.reserve(f"phone-{i}", "ip"), SmsRateLimit)
    assert store.reserve("another phone", "ip") == SmsRateLimit("SMS_IP_LIMIT", 86400 - 600)
    clock.now = 24 * 60 * 60
    assert not isinstance(store.reserve("phone", "ip"), SmsRateLimit)
    assert store.reserve("another phone", "ip") == SmsRateLimit("SMS_IP_LIMIT", 60)


def test_overlapping_limits_return_last_expiry_for_requested_phone_and_ip(memory):
    store, clock = memory
    for _ in range(9):
        reserve_with_captcha_if_required(store, "phone", "other ip")
        clock.now += SMS_RESEND_SECONDS
    for i in range(29):
        store.reserve(f"phone-{i}", "ip")
    reserve_with_captcha_if_required(store, "phone", "ip")

    assert store.reserve("phone", "ip") == SmsRateLimit("SMS_IP_LIMIT", 86400)
    assert store.reserve("phone", "other ip") == SmsRateLimit("SMS_PHONE_LIMIT", 86400 - 540)


def test_challenge_window_counts_only_accepted_reservations_and_drops_the_exact_boundary(memory):
    store, clock = memory
    assert store.refresh_captcha("phone", "ip") is None
    deliver(store, b"first")
    clock.now = 60
    deliver(store, b"second")
    clock.now = 119.99
    for request in (store.refresh_captcha, store.reserve):
        assert request("phone", "other ip") == SmsRateLimit("SMS_COOLDOWN", 1)
    clock.now = 120
    for _ in range(12):
        challenge = store.reserve("phone", "other ip")
        assert isinstance(challenge, SmsCaptcha) and challenge.code == "SMS_CAPTCHA_REQUIRED"
    assert store.claim("phone", b"second") is not None
    clock.now = SMS_CAPTCHA_WINDOW_SECONDS - 0.01
    assert isinstance(store.refresh_captcha("phone", "ip"), SmsCaptcha)
    clock.now = SMS_CAPTCHA_WINDOW_SECONDS
    assert store.refresh_captcha("phone", "ip") is None
    deliver(store, b"no-longer-needs-image")
    clock.now += SMS_RESEND_SECONDS
    # At 660 the send at 60 also leaves, independently of the send at 600.
    deliver(store, b"next")
    clock.now += SMS_RESEND_SECONDS
    assert isinstance(store.reserve("phone", "ip"), SmsCaptcha)


def test_captcha_is_phone_bound_rotates_on_refresh_and_error_and_expires(memory):
    store, clock = memory
    for when in (0, 60):
        clock.now = when
        for phone in ("phone", "other"):
            assert store.finish(phone, store.reserve(phone, "ip"), b"sent")
    clock.now = 120
    old = store.reserve("phone", "ip")
    new = store.refresh_captcha("phone", "ip")
    assert old.id != new.id
    assert store.reserve("other", "ip", new.id, new.answer).code == "SMS_CAPTCHA_INVALID"
    rotated = store.reserve("phone", "ip", old.id, old.answer)
    assert rotated.code == "SMS_CAPTCHA_INVALID"
    incorrect = store.reserve("phone", "ip", rotated.id, "１２３４")
    assert incorrect.code == "SMS_CAPTCHA_INVALID" and incorrect.id != rotated.id
    clock.now += SMS_CAPTCHA_TTL_SECONDS
    replacement = store.reserve("phone", "ip", incorrect.id, incorrect.answer)
    assert replacement.code == "SMS_CAPTCHA_INVALID"
    assert store.finish("phone", store.reserve("phone", "ip", replacement.id, replacement.answer), b"fresh")


def test_concurrent_captcha_submissions_allow_one_send_and_cannot_reuse_the_answer(memory):
    store, clock = memory
    deliver(store, b"first")
    clock.now = 60
    deliver(store, b"second")
    clock.now = 120
    challenge = store.reserve("phone", "ip")
    ready = Barrier(2)

    def submit(ip):
        ready.wait(timeout=5)
        return store.reserve("phone", ip, challenge.id, challenge.answer)

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(submit, ("ip", "other ip")))
    assert results.count(SmsRateLimit("SMS_COOLDOWN", 60)) == 1
    assert sum(store.finish("phone", result, b"third") for result in results) == 1
    clock.now += SMS_RESEND_SECONDS
    assert store.reserve("phone", "ip", challenge.id, challenge.answer).code == "SMS_CAPTCHA_INVALID"

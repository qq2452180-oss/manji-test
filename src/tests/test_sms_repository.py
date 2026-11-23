"""SMS authentication persists verified users and their session credentials."""

import psycopg

from src.service.auth import AuthRepository
from src.tests.test_guest_auth import guest_database  # noqa: F401


def test_verified_phone_rotates_token_for_original_account(guest_database):
    repository = AuthRepository(guest_database)
    phone = "+8613800000001"
    password_user = repository.create_user(phone[3:], "password-hash")
    user = repository.login_with_verified_phone(phone, "sms:first", "first-password-hash", "first-token")
    assert user["id"] != password_user["id"]
    assert repository.find_user_id_by_token("first-token") == user["id"]

    assert repository.login_with_verified_phone(phone, "sms:unused", "unused-password-hash", "second-token") == user
    assert repository.find_user_id_by_token("first-token") is None
    assert repository.find_user_id_by_token("second-token") == user["id"]
    assert repository.find_by_username(phone[3:])["password"] == "password-hash"
    with psycopg.connect(guest_database) as connection:
        rows = connection.execute("SELECT phone_e164, password FROM users ORDER BY id").fetchall()
        assert rows == [(None, "password-hash"), (phone, "first-password-hash")]

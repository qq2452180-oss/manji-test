"""补充版本的访后进度独立、事务原子性与延迟写入保护。"""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import psycopg
from psycopg.types.json import Jsonb
import pytest

from src.service.life_event import LifeEventRepository, LifeEventService
from src.service.profile import ProfileRepository
from src.service.story import StoryRepository
from src.tests.test_guest_auth import guest_database  # noqa: F401
from src.tests.test_life_event_repository import suggestion


@pytest.fixture
def revision_database(guest_database):
    with psycopg.connect(guest_database) as connection:
        connection.execute("INSERT INTO users (username, password) VALUES ('owner', 'hash'), ('other', 'hash')")
        connection.execute("INSERT INTO interview_sessions (user_id) VALUES (1), (1)")
        connection.execute(
            "INSERT INTO story (user_id, title, body, chapter_id, source_session_id, version, "
            "profile_processed, life_event_processed, summary) "
            "VALUES (1, '原故事', '原故事正文。', 1, '1', 2, TRUE, TRUE, '原故事摘要。')"
        )
        base = {"story_id": 1, "title": "原故事", "body": "原故事正文。", "chapter_id": 1}
        connection.execute(
            "INSERT INTO story_revisions (user_id, story_id, source_session_id, base_version, "
            "base_story, original_story, title, body, applied_version, status) "
            "VALUES (1, 1, '2', 1, %s, %s, '本次补充', '本次补充固定成稿。', 2, 'applied')",
            (Jsonb(base), Jsonb(base)),
        )
    return guest_database


def test_revision_flags_are_independent_from_the_original_completed_story(revision_database):
    profiles = ProfileRepository(revision_database)
    events = LifeEventRepository(revision_database)
    stories = StoryRepository(revision_database)
    assert stories.get_postprocessing_status(1, 1) == {"profile_processed": True, "life_event_processed": True}
    assert stories.get_postprocessing_status(1, 1, revision_id=1) == {
        "profile_processed": False, "life_event_processed": False,
    }
    new_profile = {"basic_background": {"current_location": "杭州"}}
    assert profiles.save_profile(1, new_profile, expected_profile={}, story_id=1, revision_id=1) == new_profile
    created = events.save_suggestion(1, 1, suggestion(), once=True, revision_id=1)
    assert created["action"] == "create"
    assert stories.get_postprocessing_status(1, 1, revision_id=1) == {
        "profile_processed": True, "life_event_processed": True,
    }
    assert profiles.save_profile(1, {"incorrect": True}, expected_profile={}, story_id=1, revision_id=1) == new_profile
    assert events.save_suggestion(1, 1, suggestion(), once=True, revision_id=1)["action"] == "skip"
    assert len(events.get_life_events(1)) == 1
    with psycopg.connect(revision_database) as connection:
        assert connection.execute("SELECT life_event_id FROM story WHERE id = 1").fetchone() == (created["event_id"],)


def test_concurrent_revision_processing_creates_one_event(revision_database):
    events = LifeEventRepository(revision_database)
    ready = Barrier(2)

    def save(_):
        ready.wait(timeout=5)
        return events.save_suggestion(1, 1, suggestion(), once=True, revision_id=1)

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(save, range(2)))
    assert sorted(value["action"] for value in outcomes) == ["create", "skip"]
    assert len(events.get_life_events(1)) == 1


def test_failed_revision_marker_rolls_back_profile_and_event_writes(revision_database):
    profiles = ProfileRepository(revision_database)
    events = LifeEventRepository(revision_database)
    with psycopg.connect(revision_database) as connection:
        connection.execute("""
            CREATE FUNCTION reject_revision_processing() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.profile_processed OR NEW.life_event_processed THEN
                    RAISE EXCEPTION 'reject revision marker';
                END IF;
                RETURN NEW;
            END;
            $$;
            CREATE TRIGGER reject_revision_processing BEFORE UPDATE ON story_revisions
            FOR EACH ROW EXECUTE FUNCTION reject_revision_processing();
        """)
    with pytest.raises(psycopg.errors.RaiseException, match="reject revision marker"):
        profiles.save_profile(1, {"new": "data"}, expected_profile={}, story_id=1, revision_id=1)
    with pytest.raises(psycopg.errors.RaiseException, match="reject revision marker"):
        events.save_suggestion(1, 1, suggestion(), once=True, revision_id=1)
    assert profiles.get_profile(1) is None
    assert events.get_life_events(1) == []
    assert StoryRepository(revision_database).get_postprocessing_status(1, 1, revision_id=1) == {
        "profile_processed": False, "life_event_processed": False,
    }


def test_revision_uses_fixed_body_and_cannot_replace_newer_story_association(revision_database):
    stories = StoryRepository(revision_database)
    events = LifeEventRepository(revision_database)
    profiles = ProfileRepository(revision_database)
    with psycopg.connect(revision_database) as connection:
        current_event = connection.execute(
            "INSERT INTO life_events (user_id, title, summary, status) VALUES (1, '当前经历', '新内容', 'told') RETURNING id"
        ).fetchone()[0]
        connection.execute(
            "UPDATE story SET version = 3, body = '后来修改过的新正文。', life_event_id = %s WHERE id = 1",
            (current_event,),
        )
    service = LifeEventService(events, stories, profiles)
    supplied = service.return_life_event_input(1, 1, revision_id=1)
    assert supplied["story"]["body"] == "本次补充固定成稿。"
    saved = events.save_suggestion(1, 1, suggestion(), once=True, revision_id=1)
    assert saved["event_id"] != current_event
    with psycopg.connect(revision_database) as connection:
        assert connection.execute("SELECT life_event_id FROM story WHERE id = 1").fetchone() == (current_event,)
        assert connection.execute("SELECT life_event_id FROM story_revisions WHERE id = 1").fetchone() == (saved["event_id"],)


def test_foreign_and_unapplied_revisions_cannot_update_memory(revision_database):
    profiles = ProfileRepository(revision_database)
    events = LifeEventRepository(revision_database)
    with pytest.raises(ValueError):
        profiles.save_profile(2, {}, expected_profile={}, story_id=1, revision_id=1)
    with pytest.raises(ValueError):
        events.save_suggestion(2, 1, suggestion(), once=True, revision_id=1)
    with psycopg.connect(revision_database) as connection:
        connection.execute("UPDATE story_revisions SET status = 'pending', applied_version = NULL WHERE id = 1")
    with pytest.raises(ValueError, match="未找到已保存的故事补充"):
        profiles.save_profile(1, {}, expected_profile={}, story_id=1, revision_id=1)
    with pytest.raises(ValueError, match="未找到已保存的故事补充"):
        events.save_suggestion(1, 1, suggestion(), once=True, revision_id=1)
    assert profiles.get_profile(1) is None
    assert events.get_life_events(1) == []

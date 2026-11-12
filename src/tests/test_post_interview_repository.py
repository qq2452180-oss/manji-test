"""访后处理完成标志的幂等与原子性；仅使用专用测试库的隔离 schema。"""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import psycopg
import pytest

from src.service.life_event import LifeEventRepository
from src.service.profile import ProfileRepository
from src.service.story import StoryRepository
from src.tests.test_life_event_repository import life_event_database, suggestion  # noqa: F401


@pytest.fixture
def postprocessing_database(life_event_database):
    return life_event_database


def test_once_concurrent_create_and_later_retry_keep_one_event(postprocessing_database):
    events = LifeEventRepository(postprocessing_database)
    stories = StoryRepository(postprocessing_database)
    ready = Barrier(2)

    def save(_):
        ready.wait(timeout=5)
        return events.save_suggestion(1, 1, suggestion(), once=True)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(save, range(2)))

    assert sorted(result["action"] for result in results) == ["create", "skip"]
    created = next(result for result in results if result["action"] == "create")
    saved = events.get_life_events(1)
    assert len(saved) == 1
    assert saved[0]["id"] == created["event_id"]
    assert stories.get_postprocessing_status(1, 1) == {
        "profile_processed": False, "life_event_processed": True,
    }
    with psycopg.connect(postprocessing_database) as connection:
        assert connection.execute("SELECT life_event_id FROM story WHERE id = 1").fetchone() == (
            created["event_id"],
        )

    retry = events.save_suggestion(1, 1, suggestion(title="重试不能新建的经历"), once=True)
    assert retry["action"] == "skip"
    assert events.get_life_events(1) == saved


def test_once_skip_is_completed_without_creating_or_linking_an_event(postprocessing_database):
    events = LifeEventRepository(postprocessing_database)
    stories = StoryRepository(postprocessing_database)
    proposal = suggestion("skip", reason="本篇故事没有明确主要经历。")

    result = events.save_suggestion(1, 1, proposal, once=True)

    assert result == {**proposal.model_dump(), "story_id": 1}
    assert stories.get_postprocessing_status(1, 1) == {
        "profile_processed": False, "life_event_processed": True,
    }
    assert events.save_suggestion(1, 1, suggestion(), once=True)["action"] == "skip"
    assert events.get_life_events(1) == []
    with psycopg.connect(postprocessing_database) as connection:
        assert connection.execute("SELECT life_event_id FROM story WHERE id = 1").fetchone() == (None,)


def test_unchanged_profile_is_completed_and_retries_preserve_current_owned_data(postprocessing_database):
    profiles = ProfileRepository(postprocessing_database)
    stories = StoryRepository(postprocessing_database)

    assert profiles.save_profile(1, {}, expected_profile={}, story_id=1) == {}
    assert stories.get_postprocessing_status(1, 1) == {
        "profile_processed": True, "life_event_processed": False,
    }
    current = {"basic_background": {"current_location": "杭州"}}
    profiles.save_profile(1, current, expected_profile={})
    assert profiles.save_profile(
        1, {"basic_background": {"current_location": "错误覆盖"}}, expected_profile={}, story_id=1,
    ) == current
    assert profiles.get_profile(1) == current

    with pytest.raises(ValueError, match="未找到该用户的故事"):
        profiles.save_profile(2, current, expected_profile={}, story_id=1)
    with pytest.raises(ValueError, match="未找到该用户的故事"):
        stories.get_postprocessing_status(2, 1)
    assert profiles.get_profile(2) is None
    assert stories.get_postprocessing_status(2, 3) == {
        "profile_processed": False, "life_event_processed": False,
    }


def test_failed_completion_marker_rolls_back_profile_and_event_then_allows_retry(postprocessing_database):
    profiles = ProfileRepository(postprocessing_database)
    events = LifeEventRepository(postprocessing_database)
    stories = StoryRepository(postprocessing_database)
    original = {"basic_background": {"birthplace": "扬州"}}
    updated = {"basic_background": {"birthplace": "扬州", "current_location": "杭州"}}
    profiles.save_profile(1, original, expected_profile={})
    with psycopg.connect(postprocessing_database) as connection:
        connection.execute("""
            CREATE FUNCTION reject_postprocessing_completion() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF (NEW.profile_processed AND NOT OLD.profile_processed)
                    OR (NEW.life_event_processed AND NOT OLD.life_event_processed) THEN
                    RAISE EXCEPTION 'reject completion marker';
                END IF;
                RETURN NEW;
            END;
            $$
        """)
        connection.execute("""
            CREATE TRIGGER reject_postprocessing_completion
            BEFORE UPDATE ON story FOR EACH ROW
            EXECUTE FUNCTION reject_postprocessing_completion()
        """)

    with pytest.raises(psycopg.errors.RaiseException, match="reject completion marker"):
        profiles.save_profile(1, updated, expected_profile=original, story_id=1)
    with pytest.raises(psycopg.errors.RaiseException, match="reject completion marker"):
        events.save_suggestion(1, 2, suggestion(), once=True)

    assert profiles.get_profile(1) == original
    assert events.get_life_events(1) == []
    for story_id in (1, 2):
        assert stories.get_postprocessing_status(1, story_id) == {
            "profile_processed": False, "life_event_processed": False,
        }
    with psycopg.connect(postprocessing_database) as connection:
        assert connection.execute("SELECT life_event_id FROM story WHERE id = 2").fetchone() == (None,)
        connection.execute("DROP TRIGGER reject_postprocessing_completion ON story")

    assert profiles.save_profile(1, updated, expected_profile=original, story_id=1) == updated
    saved = events.save_suggestion(1, 2, suggestion(), once=True)
    assert stories.get_postprocessing_status(1, 1)["profile_processed"] is True
    assert stories.get_postprocessing_status(1, 2)["life_event_processed"] is True
    assert events.get_life_events(1)[0]["id"] == saved["event_id"]

"""故事保存后更新画像与经历索引；复用已有服务和已保存的处理结果。"""

from ...service.life_event import LifeEventService
from ...service.profile import ProfileService
from ...service.story import StoryRepository
from ..state import WorkflowState


def memory_update_node(
    state: WorkflowState, *, profile_service: ProfileService | None = None,
    life_event_service: LifeEventService | None = None,
    repository: StoryRepository | None = None,
) -> WorkflowState:
    """依次更新两类记忆；重试时分别跳过已经提交的步骤。"""
    options = {'revision_id': state['revision_id']} if state.get('revision_id') else {}
    if profile_service is not None:
        processed = repository.get_postprocessing_status(state["user_id"], state["story_id"], **options)
        if not processed["profile_processed"]:
            profile_service.update_profile(
                state["user_id"], state["source_session_id"], story_id=state["story_id"], **options,
            )
    if life_event_service is not None:
        processed = repository.get_postprocessing_status(state["user_id"], state["story_id"], **options)
        if not processed["life_event_processed"]:
            life_event_service.update_life_events(state["user_id"], state["story_id"], once=True, **options)
    return {"profile_processed": True, "life_event_processed": True}

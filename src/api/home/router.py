"""主页、传记目录、章节和已完成故事的读取与编辑接口。"""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from ...service.home import HomeError
from ..auth.dependencies import get_current_user_id

router = APIRouter()


class StoryPhotoPosition(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    media_id: int = Field(gt=0)
    after_paragraph: int | None = Field(gt=0)


class StoryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: str
    body: str
    photo_layout: list[StoryPhotoPosition]
    expected_version: int | None = Field(default=None, gt=0)


async def home_error(_request: Request, exc: HomeError):
    return JSONResponse(
        {"detail": str(exc)}, status_code=exc.status_code,
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/api/home")
def get_home(request: Request, user_id: int = Depends(get_current_user_id)):
    return request.app.state.home.get_home(user_id)


@router.get("/api/stories/{story_id}")
def get_story(
    story_id: int, request: Request, user_id: int = Depends(get_current_user_id),
):
    return request.app.state.home.get_story(user_id, story_id)


@router.patch("/api/stories/{story_id}")
def update_story(
    story_id: int, body: StoryUpdate, request: Request,
    user_id: int = Depends(get_current_user_id),
):
    return request.app.state.home.update_story(
        user_id, story_id, body.title, body.body,
        [item.model_dump() for item in body.photo_layout],
        expected_version=body.expected_version,
    )


@router.get("/api/biography")
def get_biography(request: Request, user_id: int = Depends(get_current_user_id)):
    return request.app.state.home.get_biography(user_id)


@router.get("/api/chapters/{chapter_id}")
def get_chapter(
    chapter_id: int, request: Request, user_id: int = Depends(get_current_user_id),
):
    return request.app.state.home.get_chapter(user_id, chapter_id)

"""开场、恢复会话、图片及文字输入、结束访谈、重试、图片读取接口。

每条输入追加到同一个 LangGraph 会话，并触发一次访谈回复。
上传图片时先保存文件和媒体信息，再将图片作为当前轮输入。
"""

from fastapi import APIRouter, Body, Depends, File, Form, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ...service.interview import InterviewError
from ...service.interview.session import ResumeMode
from ...service.media.errors import (
    MediaError, MediaNotFoundError, MediaStorageError, MediaTooLargeError,
    MediaUnsupportedError,
)
from ..auth.dependencies import get_current_user_id

router = APIRouter()
PRIVATE_HEADERS = {"Cache-Control": "private, no-store"}


class InterviewInput(BaseModel):
    text: str


class InterviewStart(BaseModel):
    resume_mode: ResumeMode | None = None
    topic_id: int | None = Field(default=None, strict=True, gt=0, le=9223372036854775807)
    target_story_id: int | None = Field(default=None, strict=True, gt=0, le=9223372036854775807)


class InterviewFinish(BaseModel):
    rebase: bool = False


class InterviewMode(BaseModel):
    resume_mode: ResumeMode


async def interview_error(_request: Request, exc: InterviewError):
    payload = {"detail": str(exc)}
    if exc.code is not None:
        payload["code"] = exc.code
    if exc.session_id is not None:
        payload["session_id"] = exc.session_id
    return JSONResponse(payload, status_code=exc.status_code, headers=PRIVATE_HEADERS)


async def media_error(_request: Request, exc: MediaError):
    status = next((code for kind, code in (
        (MediaNotFoundError, 404), (MediaTooLargeError, 413),
        (MediaUnsupportedError, 415), (MediaStorageError, 503),
    ) if isinstance(exc, kind)), 400)
    return JSONResponse({"detail": str(exc)}, status_code=status, headers=PRIVATE_HEADERS)


@router.post("/api/interviews", status_code=201)
def start_interview(
    body: InterviewStart, request: Request, user_id: int = Depends(get_current_user_id),
):
    return request.app.state.interview.start(
        user_id, resume_mode=body.resume_mode, topic_id=body.topic_id,
        **({"target_story_id": body.target_story_id} if body.target_story_id is not None else {}),
    )


@router.get("/api/interviews/{session_id}")
def get_interview(
    session_id: str, request: Request, user_id: int = Depends(get_current_user_id),
):
    return request.app.state.interview.get_session(user_id, session_id)


@router.post("/api/interviews/{session_id}/resume")
def resume_interview(
    session_id: str, request: Request, user_id: int = Depends(get_current_user_id),
):
    return request.app.state.interview.resume(user_id, session_id)


@router.patch("/api/interviews/{session_id}/mode")
def update_interview_mode(
    session_id: str, body: InterviewMode, request: Request,
    user_id: int = Depends(get_current_user_id),
):
    return request.app.state.interview.update_mode(user_id, session_id, body.resume_mode)


@router.post("/api/interviews/{session_id}/photos", status_code=201)
def upload_photo(
    session_id: str, request: Request,
    photo: UploadFile = File(...), text: str = Form(""),
    user_id: int = Depends(get_current_user_id),
):
    return request.app.state.interview.upload_photo(user_id, session_id, photo.file, text)


@router.post("/api/interviews/{session_id}/input")
def submit_text(
    session_id: str, body: InterviewInput, request: Request,
    user_id: int = Depends(get_current_user_id),
):
    return request.app.state.interview.submit_text(user_id, session_id, body.text)


@router.post("/api/interviews/{session_id}/finish")
def finish_interview(
    session_id: str, request: Request,
    user_id: int = Depends(get_current_user_id),
    body: InterviewFinish | None = Body(default=None),
):
    return request.app.state.interview.finish(
        user_id, session_id, **({'rebase': True} if body and body.rebase else {}),
    )


@router.post("/api/interviews/{session_id}/retry")
def retry_reply(
    session_id: str, request: Request,
    user_id: int = Depends(get_current_user_id),
):
    return request.app.state.interview.retry(user_id, session_id)


@router.get("/api/interviews/{session_id}/photos/{media_id}")
def read_photo(
    session_id: str, media_id: int, request: Request,
    user_id: int = Depends(get_current_user_id),
):
    data, mime_type = request.app.state.media.read(user_id, session_id, media_id)
    return Response(data, media_type=mime_type, headers={
        **PRIVATE_HEADERS, "X-Content-Type-Options": "nosniff",
    })

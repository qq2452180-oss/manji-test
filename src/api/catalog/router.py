"""公开读取已启用的章节和话题。"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, StringConstraints

from ...service.catalog import CatalogError
from ..auth.dependencies import get_current_user_id


router = APIRouter()


async def catalog_error(_request: Request, exc: CatalogError):
    return JSONResponse(
        {"detail": str(exc)}, status_code=exc.status_code,
        headers={"Cache-Control": "no-store"},
    )


@router.get("/api/catalog")
def get_catalog(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.catalog.list_catalog()


class DecadeSelection(BaseModel):
    birth_decade: Literal[50, 60, 70]
    occupation: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)] | None = None


@router.get("/api/catalog/mine")
def member_catalog(request: Request, user_id: int = Depends(get_current_user_id)):
    return request.app.state.catalog.member_catalog(user_id)


@router.put("/api/catalog/mine")
def select_decade(selection: DecadeSelection, request: Request, user_id: int = Depends(get_current_user_id)):
    return request.app.state.catalog.select_catalog(user_id, selection.birth_decade, selection.occupation)

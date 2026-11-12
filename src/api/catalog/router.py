"""公开读取已启用的章节和话题。"""

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from ...service.catalog import CatalogError


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

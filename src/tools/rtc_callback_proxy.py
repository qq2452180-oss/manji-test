"""本地语音联调入口：只转发两个经过鉴权的 RTC POST 接口。"""

import asyncio
from contextlib import asynccontextmanager
import logging
import os

import httpx
from starlette.applications import Starlette
from starlette.requests import ClientDisconnect, Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route


PATHS = ("/api/rtc/llm/chat/completions", "/api/rtc/events")
BACKEND_PORT = int(os.environ.get("MANJI_RTC_BACKEND_PORT", "8003"))
MAX_BODY_BYTES = 256 * 1024
HEADERS = {
    "content-type", "authorization", "sign", "sdkappid", "x-sdk-app-id",
    "x-task-id", "x-request-id", "x-user-id", "x-room-id", "x-room-id-type",
    "x-invoke-llm",
}


@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient(
        trust_env=False, follow_redirects=False,
        timeout=httpx.Timeout(connect=5, read=65, write=15, pool=5),
    ) as client:
        app.state.upstream = client
        yield


def error(status, code):
    return JSONResponse({"code": code}, status_code=status,
                        headers={"Cache-Control": "private, no-store"})


async def forward(request: Request):
    path = request.scope.get("raw_path", b"")
    if path not in {p.encode("ascii") for p in PATHS} or request.scope.get("query_string"):
        return error(404, "RTC_PROXY_ROUTE_NOT_FOUND")
    if request.headers.get("content-encoding", "identity").lower() != "identity":
        return error(415, "RTC_PROXY_ENCODING_UNSUPPORTED")
    try:
        if int(request.headers.get("content-length", "0")) > MAX_BODY_BYTES:
            return error(413, "RTC_REQUEST_TOO_LARGE")
        body = bytearray()
        async with asyncio.timeout(15):
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_BODY_BYTES:
                    return error(413, "RTC_REQUEST_TOO_LARGE")
                body.extend(chunk)
    except (ValueError, ClientDisconnect):
        return error(400, "RTC_PROXY_BODY_INVALID")
    except TimeoutError:
        return error(408, "RTC_PROXY_BODY_TIMEOUT")
    try:
        upstream = await request.app.state.upstream.post(
            f"http://127.0.0.1:{BACKEND_PORT}" + path.decode("ascii"), content=bytes(body),
            headers={k: v for k, v in request.headers.items() if k in HEADERS},
        )
    except httpx.TimeoutException:
        return error(504, "RTC_PROXY_UPSTREAM_TIMEOUT")
    except httpx.HTTPError:
        return error(502, "RTC_PROXY_UPSTREAM_UNAVAILABLE")
    if upstream.is_redirect:
        return error(502, "RTC_PROXY_UPSTREAM_REDIRECT")
    logging.getLogger("rtc_proxy").info("forwarded path=%s status=%d", path.decode(), upstream.status_code)
    return Response(upstream.content, status_code=upstream.status_code, headers={
        "content-type": upstream.headers.get("content-type", "application/json"),
        "cache-control": "private, no-store",
    })


app = Starlette(routes=[Route(path, forward, methods=["POST"]) for path in PATHS], lifespan=lifespan)
app.router.redirect_slashes = False


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    uvicorn.run(app, host="127.0.0.1", port=18084, access_log=False)

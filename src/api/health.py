"""容器存活与发布就绪检查；不调用模型或腾讯服务。"""

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
import psycopg

from ..common.migrate import MigrationError, check_schema


router = APIRouter(tags=["运行状态"])
_WEB_PAGES = (
    "index", "interview", "organizing", "story", "biography", "chapter", "history", "profile", "preview",
)


class _PageAssets(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.urls: list[str] = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "script" and attributes.get("src"):
            self.urls.append(attributes["src"])
        elif tag == "link" and attributes.get("rel") in {"stylesheet", "modulepreload"}:
            if attributes.get("href"):
                self.urls.append(attributes["href"])


class ReadinessCheck:
    def __init__(self, database_url: str, web_directory: Path) -> None:
        self._database_url = database_url
        self._web_directory = web_directory

    def failure_code(self) -> str | None:
        """返回固定故障码，避免把连接串、服务器路径或数据库异常回给探针。"""
        if not self._database_url.strip():
            return "DATABASE_UNAVAILABLE"
        try:
            with psycopg.connect(self._database_url, connect_timeout=3) as connection:
                # Preserve DSN options such as search_path; probe the same schema as the app.
                connection.read_only = True
                connection.execute("SET LOCAL statement_timeout = '3s'")
                check_schema(connection)
        except (MigrationError, OSError, UnicodeError):
            return "SCHEMA_NOT_READY"
        except psycopg.Error:
            return "DATABASE_UNAVAILABLE"

        try:
            root = self._web_directory.resolve()
            for page in _WEB_PAGES:
                parser = _PageAssets()
                markup = (root / f"{page}.html").read_text(encoding="utf-8")
                parser.feed(markup)
                if not parser.urls:
                    return "WEB_BUILD_NOT_READY"
                for url in parser.urls:
                    parsed = urlsplit(url)
                    if parsed.scheme or parsed.netloc:
                        continue
                    relative = parsed.path.removeprefix("/web/")
                    asset = (root / relative).resolve()
                    if not asset.is_relative_to(root) or not asset.is_file():
                        return "WEB_BUILD_NOT_READY"
        except (OSError, UnicodeError, ValueError):
            return "WEB_BUILD_NOT_READY"
        return None


@router.get("/api/health", include_in_schema=False)
def health():
    return JSONResponse({"status": "ok"}, headers={"Cache-Control": "no-store"})


@router.get("/api/ready", include_in_schema=False)
def ready(request: Request):
    code = request.app.state.readiness.failure_code()
    payload = {"status": "not_ready", "code": code} if code else {"status": "ready"}
    return JSONResponse(payload, status_code=503 if code else 200,
                        headers={"Cache-Control": "no-store"})

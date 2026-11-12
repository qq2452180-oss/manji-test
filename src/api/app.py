"""创建应用并装配共享服务；具体接口放在对应的 API 目录。"""

from contextlib import asynccontextmanager
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from ..common.tencent_rtc import TencentRtcProvider
from ..langgraph.graph import build_graph
from ..service.auth import AuthRepository, AuthService
from ..service.catalog import CatalogError, CatalogRepository, CatalogService
from ..service.home import HomeError, HomeService
from ..service.home.progress import TopicProgressRepository
from ..service.interview import InterviewError, InterviewService, InterviewMemoryService
from ..service.interview.repository import InterviewSessionRepository
from ..service.life_event import LifeEventRepository, LifeEventService
from ..service.profile import ProfileRepository, ProfileService
from ..service.media import LocalMediaStorage, MediaRepository, MediaService
from ..service.media.errors import MediaError
from ..service.story import StoryRepository
from ..service.biography import BiographyRepository, BiographyService
from ..service.rtc import DirectRtcService
from .auth.router import router as auth_router
from .catalog.router import catalog_error, router as catalog_router
from .health import ReadinessCheck, router as health_router
from .home.router import home_error, router as home_router
from .interview.router import interview_error, media_error, router as interview_router
from .rtc.config import load_rtc_provider
from .rtc.router import router as rtc_router

SRC_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = SRC_DIR.parent


def create_app(
    *, database_url: str | None = None,
    media_directory: Path | None = None, max_photo_bytes: int = 10 * 1024 * 1024,
    rtc_provider: TencentRtcProvider | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        load_dotenv(SRC_DIR / ".env")
        dsn = database_url if database_url is not None else os.getenv("MANJILU_DATABASE_URL", "")
        app.state.readiness = ReadinessCheck(dsn, SRC_DIR / "web" / "dist")
        app.state.auth = AuthService(AuthRepository(dsn))
        app.state.catalog = CatalogService(CatalogRepository(dsn))
        root = media_directory or Path(
            os.getenv("MANJI_LANGGRAPH_MEDIA_DIRECTORY") or PROJECT_ROOT / "data" / "langgraph-media"
        )
        app.state.media = MediaService(
            MediaRepository(dsn),
            LocalMediaStorage(root / "files"),
            max_bytes=max_photo_bytes,
        )
        stories = StoryRepository(dsn)
        interviews = InterviewSessionRepository(dsn)
        profiles = ProfileRepository(dsn)
        events = LifeEventRepository(dsn)
        biographies = BiographyService(BiographyRepository(dsn))
        app.state.home = HomeService(interviews, stories, progress=TopicProgressRepository(dsn),
                                     biography_service=biographies)
        app.state.interview = InterviewService(
            build_graph(
                story_repository=stories,
                profile_service=ProfileService(profiles, interviews),
                life_event_service=LifeEventService(events, stories, profiles),
            ), app.state.media, interviews,
            story_repository=stories,
            memory_inputs=InterviewMemoryService(profiles, events, stories),
            catalog=app.state.catalog,
            biography_service=biographies,
        )
        provider = rtc_provider if rtc_provider is not None else load_rtc_provider()
        # RTC 仅使用进程内存（单实例、单 worker）；消息仍由现有访谈服务保存。
        app.state.rtc = DirectRtcService(provider, app.state.interview) if provider is not None else None
        try:
            yield
        finally:
            if app.state.rtc is not None:
                await run_in_threadpool(app.state.rtc.close)

    app = FastAPI(title="慢记 LangGraph 本地接入", lifespan=lifespan)
    app.add_exception_handler(InterviewError, interview_error)
    app.add_exception_handler(MediaError, media_error)
    app.add_exception_handler(HomeError, home_error)
    app.add_exception_handler(CatalogError, catalog_error)
    app.include_router(auth_router)
    app.include_router(catalog_router)
    app.include_router(health_router)
    app.include_router(home_router)
    app.include_router(interview_router)
    app.include_router(rtc_router)

    @app.get("/", include_in_schema=False)
    def web_index():
        return RedirectResponse(url="/web/index.html")

    app.mount(
        "/web", StaticFiles(directory=SRC_DIR / "web" / "dist", html=True, check_dir=False),
        name="web",
    )
    return app

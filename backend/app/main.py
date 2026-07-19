import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import settings

# 控制台日志：DEBUG=true 输出所有日志，否则只输出 WARNING 以上
logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.WARNING,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
# 第三方库日志静默（DEBUG 模式下也只输出 WARNING）
logging.getLogger("aiosqlite").setLevel(logging.WARNING)
logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import engine, Base, async_session
from app.routers import auth, canvas, files, model_config, assets, generate, ai_proxy


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Starting up (DEBUG={settings.DEBUG})")
    # Startup: ensure tables exist and default admin is created
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    from app.services.auth import ensure_admin_exists

    async with async_session() as db:
        await ensure_admin_exists(db)
    logger.info("Database initialized, admin ensured")

    # Start background worker for generation task queue
    from app.services.worker import worker_loop

    worker_task = asyncio.create_task(worker_loop())
    logger.info("Background worker started")
    yield
    # Shutdown: cancel worker and clean up connection pool
    logger.info("Shutting down")
    worker_task.cancel()
    await engine.dispose()


app = FastAPI(
    title=settings.APP_NAME,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.CORS_ORIGINS.strip() == "*" else [s.strip() for s in settings.CORS_ORIGINS.split(",") if s.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(canvas.router)
app.include_router(files.router)
app.include_router(model_config.router)
app.include_router(assets.router)
app.include_router(generate.router)
app.include_router(ai_proxy.router)

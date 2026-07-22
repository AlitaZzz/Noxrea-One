import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import settings
from app.logging_config import setup_logging

# 统一日志配置：彩色 + 对齐 + 第三方库静默。须在 import 各业务模块前调用。
setup_logging()
logger = logging.getLogger(__name__)
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import engine, Base, async_session
from app.routers import auth, canvas, files, model_config, assets, generate, ai_proxy


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"startup log_level={settings.LOG_LEVEL}")
    # Startup: 开发兜底建表；生产应以 `alembic upgrade head` 为准（create_all 只建缺失的表，
    # 不会改已有表结构，会掩盖迁移未执行的情况）。
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    # 开发兜底：为既有表补缺失列（create_all 不会改已有表结构）。生产请用 alembic 迁移。
    try:
        async with engine.begin() as conn:
            from sqlalchemy import text
            await conn.execute(
                text("ALTER TABLE model_infos ADD COLUMN inferred_capabilities JSON NOT NULL DEFAULT '[]'")
            )
    except Exception:
        pass
    logger.warning("create_all ran (dev fallback). 生产请使用 `alembic upgrade head` 管理表结构。")
    from app.services.auth import ensure_admin_exists

    async with async_session() as db:
        await ensure_admin_exists(db)
    logger.info("database initialized")

    # Start background worker for generation task queue
    from app.services.worker import worker_loop

    worker_task = asyncio.create_task(worker_loop())
    logger.info("worker started")
    yield
    # Shutdown: cancel worker and clean up connection pool
    logger.info("shutdown")
    worker_task.cancel()
    await engine.dispose()


app = FastAPI(
    title=settings.APP_NAME,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.CORS_ORIGINS.strip() == "*" else [s.strip() for s in settings.CORS_ORIGINS.split(",") if s.strip()],
    # allow_credentials=True 与 allow_origins=["*"] 不兼容（Starlette 会回退为回显 Origin，
    # 等价于任意源可带凭据跨域）。仅当显式指定白名单来源时才开启 credentials。
    allow_credentials=settings.CORS_ORIGINS.strip() != "*",
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

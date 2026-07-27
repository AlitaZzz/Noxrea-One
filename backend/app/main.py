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
from app.routers import auth, canvas, files, model_config, assets, generate, ai_proxy, model_params


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"startup log_level={settings.LOG_LEVEL}")
    # Startup: 开发兜底建表；生产应以 `alembic upgrade head` 为准（create_all 只建缺失的表，
    # 不会改已有表结构，会掩盖迁移未执行的情况）。
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.warning(
        "create_all 已执行（仅建缺失表、不动已有表结构）。"
        "生产环境应以 `alembic upgrade head` 作为唯一表结构变更入口。"
    )

    # 开发兜底：补齐已存在表缺失的新列（create_all 不会给旧表加列）
    from app.services.db_migrate import ensure_schema_migrations

    await ensure_schema_migrations(engine)
    logger.info("schema migration check done")
    from app.services.auth import ensure_admin_exists

    async with async_session() as db:
        await ensure_admin_exists(db)
    logger.info("database initialized")

    # SQLite: 开启 WAL 减少并发写锁竞争（worker 与请求处理器共享同一 engine）。
    # WAL 是数据库文件级持久属性，启动时确保一次即可。
    if "sqlite" in settings.DATABASE_URL:
        from sqlalchemy import text as _wal_text
        try:
            async with engine.connect() as conn:
                await conn.execute(_wal_text("PRAGMA journal_mode=WAL"))
        except Exception as e:
            logger.warning(f"enable WAL failed (ignored): {e}")

    # 初始化 AI Gateway 注册中心（Capability/Protocol/Adapter Registry）。
    # 必须在 worker 启动前调用，否则注册表为空，所有网关任务都会因
    # "Unknown capability" 而失败（重构引入的注册模式依赖此初始化）。
    from app.services.gateway.registry import init_gateway

    init_gateway()
    logger.info("gateway registry initialized")

    # Start background worker for generation task queue
    from app.services.worker import worker_loop

    worker_stop = asyncio.Event()
    worker_task = asyncio.create_task(worker_loop(worker_stop))
    logger.info("worker started")
    yield
    # Shutdown: signal worker to stop, drain in-flight tasks, THEN dispose pool.
    # 顺序很关键：必须在 engine.dispose() 之前让 worker 真正退出，否则在途子任务
    # 仍会访问已销毁的连接池（sqlite3.OperationalError: no active connection）。
    logger.info("shutdown")
    worker_stop.set()
    try:
        await asyncio.wait_for(worker_task, timeout=15.0)
    except asyncio.TimeoutError:
        # 优雅退出超时（如有任务卡在无法取消的 IO）：强制取消兜底
        logger.warning("worker did not stop in 15s, cancelling")
        worker_task.cancel()
        try:
            await worker_task
        except asyncio.CancelledError:
            pass
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
app.include_router(model_params.router)

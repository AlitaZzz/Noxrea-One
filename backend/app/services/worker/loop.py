"""Worker 后台调度：轮询领取、并发派发、僵尸清理。不含任何业务逻辑。"""

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.crud import task as crud_task
from app.database import async_session
from app.models.task import GenerationTask

logger = logging.getLogger(__name__)

# ── Constants ───────────────────────────────────────────────────

POLL_INTERVAL_SEC = settings.WORKER_POLL_INTERVAL
MAX_CONCURRENCY = settings.WORKER_MAX_CONCURRENCY
STUCK_TIMEOUT_MIN = settings.WORKER_STUCK_TIMEOUT
ZOMBIE_CHECK_INTERVAL = settings.WORKER_ZOMBIE_INTERVAL


# ── Atomic task claim ──────────────────────────────────────────


async def _claim_tasks(db: AsyncSession, limit: int = 10) -> list[GenerationTask]:
    """原子地批量领取最多 limit 条 pending 任务。

    委托 crud_task.claim_pending_tasks：声明式 update(...).returning(GenerationTask)
    返回 ORM 对象，config/ref_urls 已按模型声明反序列化为 dict/list。
    """
    return await crud_task.claim_pending_tasks(db, limit)


# ── Zombie cleanup ─────────────────────────────────────────────


async def _cleanup_zombies(db: AsyncSession) -> None:
    """Mark tasks stuck in 'processing' for > STUCK_TIMEOUT_MIN as failed."""
    now = datetime.now(timezone.utc)
    cutoff = datetime.fromtimestamp(
        now.timestamp() - STUCK_TIMEOUT_MIN * 60, tz=timezone.utc
    )
    n = await crud_task.cleanup_zombie_tasks(db, cutoff, now)
    if n:
        logger.warning(f"cleaned up {n} zombie task(s)")


# ── Main loop ──────────────────────────────────────────────────


async def worker_loop(stop_event: asyncio.Event | None = None) -> None:
    """Main worker loop — runs as an asyncio background task.

    纯调度：领取任务后交由 executor.process_task 执行，调度与执行物理解耦。

    stop_event: 由 lifespan 在关闭时 set，用于触发优雅退出——取消在途任务、等待其
    结束后才返回，避免在 engine.dispose() 之后仍有任务访问已销毁的连接池。
    未传入时退化为无限轮询（依赖外部 cancel 退出，仅用于向后兼容）。
    """
    # 延迟 import，保持调度层与执行层解耦，避免模块级循环依赖。
    from app.services.worker.executor import process_task

    logger.info(f"worker started max_concurrency={MAX_CONCURRENCY} stuck_timeout={STUCK_TIMEOUT_MIN}min")

    semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
    in_flight: set[asyncio.Task] = set()
    zombie_tick = 0

    async def _run(task: GenerationTask) -> None:
        async with semaphore:
            await process_task(task)

    try:
        while not (stop_event is not None and stop_event.is_set()):
            try:
                # ── Zombie cleanup (every ZOMBIE_CHECK_INTERVAL seconds) ──
                zombie_tick += 1
                if zombie_tick >= ZOMBIE_CHECK_INTERVAL // POLL_INTERVAL_SEC:
                    zombie_tick = 0
                    async with async_session() as db:
                        await _cleanup_zombies(db)

                # ── Claim pending tasks ──
                async with async_session() as db:
                    tasks = await _claim_tasks(db)
                if tasks:
                    logger.info(f"[worker] claimed={len(tasks)}")

                # ── Process tasks concurrently (Semaphore limits to MAX_CONCURRENCY) ──
                for task in tasks:
                    logger.info(f"[worker] dispatch task={task.id} to executor")
                    child = asyncio.create_task(_run(task))
                    in_flight.add(child)
                    child.add_done_callback(in_flight.discard)

            except asyncio.CancelledError:
                # 被显式 cancel（signal/超时）：跳出循环，交给 finally 优雅排空
                break
            except Exception as e:
                logger.error(f"loop error: {e}")

            # 等待至下一轮轮询；stop_event 一旦 set 立即唤醒（不再空等一个完整周期）
            try:
                if stop_event is not None:
                    await asyncio.wait_for(stop_event.wait(), timeout=POLL_INTERVAL_SEC)
                else:
                    await asyncio.sleep(POLL_INTERVAL_SEC)
            except asyncio.TimeoutError:
                pass
    finally:
        # 优雅排空：取消仍在执行的任务并等待其结束，再释放连接池。
        # 否则 fire-and-forget 的子任务会在 engine.dispose() 之后访问连接池，
        # 触发 sqlite3.OperationalError: no active connection。
        for t in in_flight:
            t.cancel()
        if in_flight:
            try:
                await asyncio.gather(*in_flight, return_exceptions=True)
            except asyncio.CancelledError:
                # 外层亦被取消：再尽力排空一次（子任务已 cancel，通常立即返回）
                await asyncio.gather(*in_flight, return_exceptions=True)
        logger.info("worker stopped")

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import GenerationTask


async def create_task(
    db: AsyncSession,
    task_id: str,
    user_id: int,
    type_: str,
    prompt: str,
    config: dict,
    ref_urls: list[str],
    node_id: str,
    now: datetime,
) -> GenerationTask:
    """创建生成任务。"""
    task = GenerationTask(
        id=task_id,
        user_id=user_id,
        type=type_,
        status="pending",
        prompt=prompt,
        config=config,
        ref_urls=ref_urls or None,
        node_id=node_id,
        created_at=now,
        updated_at=now,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return task


async def get_task(db: AsyncSession, task_id: str) -> Optional[GenerationTask]:
    """按 ID 查询任务（不含所有权过滤）。"""
    result = await db.execute(
        select(GenerationTask).where(GenerationTask.id == task_id)
    )
    return result.scalar_one_or_none()


async def get_task_for_user(
    db: AsyncSession, task_id: str, user_id: int
) -> Optional[GenerationTask]:
    """按 ID + user_id 查询任务（含所有权过滤）。"""
    result = await db.execute(
        select(GenerationTask).where(
            GenerationTask.id == task_id, GenerationTask.user_id == user_id
        )
    )
    return result.scalar_one_or_none()


async def get_task_status(
    db: AsyncSession, task_id: str
) -> Optional[tuple[int, str]]:
    """仅查询任务的 user_id 和 status（用于取消前的检查）。"""
    result = await db.execute(
        select(GenerationTask.user_id, GenerationTask.status).where(
            GenerationTask.id == task_id
        )
    )
    return result.fetchone()


async def cancel_task(db: AsyncSession, task_id: str, now: datetime) -> None:
    """将任务标记为已取消。"""
    await db.execute(
        update(GenerationTask)
        .where(GenerationTask.id == task_id)
        .values(status="failed", error="Cancelled", updated_at=now)
    )
    await db.commit()


async def claim_pending_tasks(db: AsyncSession, limit: int = 10) -> list[GenerationTask]:
    """原子批量领取 pending 任务并置为 processing。

    使用声明式 update(...).returning(GenerationTask)：返回的是 ORM 对象，
    config/ref_urls 按模型声明的 JSON 列自动反序列化为 dict/list，不再出现
    "字符串伪装成 dict" 的静默类型错位；列映射由 ORM 维护，不再依赖下标。
    """
    now = datetime.now(timezone.utc)
    stmt = (
        update(GenerationTask)
        .where(
            GenerationTask.id.in_(
                select(GenerationTask.id)
                .where(GenerationTask.status == "pending")
                .order_by(GenerationTask.created_at.asc())
                .limit(limit)
            )
        )
        .values(status="processing", updated_at=now)
        .returning(GenerationTask)
    )
    result = await db.execute(stmt)
    tasks = list(result.scalars().all())
    await db.commit()
    return tasks


async def update_task_status(
    db: AsyncSession,
    task_id: str,
    status: str,
    *,
    result_url: str | None = None,
    error: str | None = None,
) -> None:
    """更新任务状态。

    取消保护：任务已为 failed（被取消）时，completed 不会被覆盖，
    避免取消后的任务被误标为完成。
    """
    now = datetime.now(timezone.utc)
    if status == "completed":
        cur = await db.execute(
            select(GenerationTask.status).where(GenerationTask.id == task_id)
        )
        if cur.scalar_one_or_none() == "failed":
            return
    await db.execute(
        update(GenerationTask)
        .where(GenerationTask.id == task_id)
        .values(
            status=status,
            updated_at=now,
            result_url=result_url or "",
            error=error or "",
        )
    )
    await db.commit()


async def cleanup_zombie_tasks(
    db: AsyncSession, cutoff: datetime, now: datetime
) -> int:
    """将卡在 processing 且 updated_at < cutoff 的任务标为失败，返回受影响行数。"""
    result = await db.execute(
        update(GenerationTask)
        .where(
            GenerationTask.status == "processing",
            GenerationTask.updated_at < cutoff,
        )
        .values(status="failed", error="Task timed out", updated_at=now)
    )
    await db.commit()
    return result.rowcount

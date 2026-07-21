from datetime import datetime
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

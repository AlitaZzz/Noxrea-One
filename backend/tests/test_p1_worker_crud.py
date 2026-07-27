"""
P1: Worker 改走 crud 层 + 声明式 JSON 列，消除手搓 SQL 导致的静默失效。

覆盖点：
- claim_pending_tasks 返回 ORM 对象：config 为 dict、ref_images 为 list（而非 str）
  —— 直接验证根因 1（"字符串伪装成 dict"）已消除
- claim 仅领 pending、按 created_at 排序、受 limit 限制
- update_task_status 取消保护：failed（已取消）不被 completed 覆盖
- cleanup_zombie_tasks：老 processing 标 failed、新 processing 不动、返回正确行数
- _process_task 集成：claim 给的 dict config / list ref_images 流到处理函数，
  不再依赖 json.loads 补丁也能正确解析
"""
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, update

import app.services.worker.executor as executor
from app.crud import task as crud_task
from app.models.task import GenerationTask

CONFIG = {"model": "test-model", "channel_id": 1}


@pytest.mark.asyncio
async def test_claim_returns_orm_with_deserialized_json(db):
    """根因 1 修复验证：JSON 列按声明反序列化为 dict/list，不是 str。"""
    base = datetime.now(timezone.utc)
    await crud_task.create_task(
        db, "a", 1, "image", "p",
        {"model": "x", "channel_id": 1}, ["u1", "u2"], "node1", base,
    )
    await crud_task.create_task(
        db, "b", 1, "image", "p",
        {"model": "y"}, None, "node1", base + timedelta(seconds=1),
    )
    claimed = await crud_task.claim_pending_tasks(db, 10)
    assert len(claimed) == 2
    for t in claimed:
        assert isinstance(t.config, dict), "config 必须是 dict，不能是 str（根因已修复）"
        assert isinstance(t.ref_images, (list, type(None))), "ref_images 必须是 list/None，不能是 str"
    # 按 created_at ASC 排序：a 先创建，应在前
    assert [t.id for t in claimed] == ["a", "b"]


@pytest.mark.asyncio
async def test_claim_respects_limit_and_only_pending(db):
    """claim 只领 pending，且受 limit 限制。"""
    base = datetime.now(timezone.utc)
    for i in range(5):
        await crud_task.create_task(
            db, f"t{i}", 1, "image", "p",
            CONFIG, None, "node1", base + timedelta(seconds=i),
        )
    claimed = await crud_task.claim_pending_tasks(db, 3)
    assert len(claimed) == 3
    assert {t.id for t in claimed} == {"t0", "t1", "t2"}
    # 剩余 2 条仍为 pending
    remaining = (await db.execute(
        select(GenerationTask).where(GenerationTask.status == "pending")
    )).scalars().all()
    assert len(remaining) == 2


@pytest.mark.asyncio
async def test_update_status_cancelled_not_overwritten(db):
    """取消保护：已被取消(failed)的任务，completed 不应覆盖。"""
    now = datetime.now(timezone.utc)
    await crud_task.create_task(db, "c", 1, "image", "p", CONFIG, None, "node1", now)
    await crud_task.update_task_status(db, "c", "failed", error="Cancelled")
    # provider 完成回调不应覆盖已取消状态
    await crud_task.update_task_status(db, "c", "completed", result_urls=["http://x/y.png"])
    final = await crud_task.get_task(db, "c")
    assert final.status == "failed"
    assert final.error == "Cancelled"


@pytest.mark.asyncio
async def test_update_status_completes_when_pending(db):
    """pending 任务可被正常标为 completed 并写入 result_url。"""
    now = datetime.now(timezone.utc)
    await crud_task.create_task(db, "d", 1, "image", "p", CONFIG, None, "node1", now)
    await crud_task.update_task_status(db, "d", "completed", result_urls=["http://x/y.png"])
    final = await crud_task.get_task(db, "d")
    assert final.status == "completed"
    assert final.result_urls == ["http://x/y.png"]
    assert final.result_url == "http://x/y.png"


@pytest.mark.asyncio
async def test_cleanup_zombies_marks_stuck_processing(db):
    """老 processing 标 failed，新 processing 不动，返回正确行数。"""
    now = datetime.now(timezone.utc)
    old = now - timedelta(minutes=30)
    await crud_task.create_task(db, "z1", 1, "image", "p", CONFIG, None, "node1", old)
    await db.execute(
        update(GenerationTask)
        .where(GenerationTask.id == "z1")
        .values(status="processing", updated_at=old)
    )
    await crud_task.create_task(db, "z2", 1, "image", "p", CONFIG, None, "node1", now)
    await db.execute(
        update(GenerationTask)
        .where(GenerationTask.id == "z2")
        .values(status="processing", updated_at=now)
    )

    cutoff = now - timedelta(minutes=10)
    n = await crud_task.cleanup_zombie_tasks(db, cutoff, now)
    assert n == 1

    z1 = await crud_task.get_task(db, "z1")
    z2 = await crud_task.get_task(db, "z2")
    assert z1.status == "failed"
    assert z1.error == "Task timed out"
    assert z2.status == "processing"


@pytest.mark.asyncio
async def test_process_task_uses_dict_config_without_json_loads(db, monkeypatch):
    """端到端验证：claim 给的 dict config / list ref_images 流到 executor.process_task，无需 json.loads。"""
    now = datetime.now(timezone.utc)
    await crud_task.create_task(
        db, "bg1", 1, "bg_removal", "p",
        {"model": "rembg"}, ["http://testserver/api/files/1/ab/x.png"],
        "node1", now,
    )
    claimed = await crud_task.claim_pending_tasks(db, 10)
    task = claimed[0]
    assert isinstance(task.config, dict)
    assert isinstance(task.ref_images, list)

    # 把 executor 内部的 async_session 重定向到测试 session，保证状态可见
    @asynccontextmanager
    async def _same_session():
        yield db

    monkeypatch.setattr(executor, "async_session", _same_session)

    seen: dict = {}

    async def fake_bg(t):
        # 到达内部推理封装时，ref_images 必须是 list（而非 str）
        seen["ref_images"] = t.ref_images
        return "http://testserver/api/files/1/gen/r.png", None

    monkeypatch.setattr("app.services.inference.bg_removal.process", fake_bg)

    async def fake_download(url, user_id, typ, task_id=""):
        return url

    monkeypatch.setattr(executor.StorageService, "download_and_save",
                        staticmethod(fake_download))

    await executor.process_task(task)

    assert isinstance(seen["ref_images"], list)
    final = await crud_task.get_task(db, "bg1")
    assert final.status == "completed"

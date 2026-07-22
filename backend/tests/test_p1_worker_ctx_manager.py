"""
回归：worker._process_task 的 dns_pin 上下文管理器修复。

之前用 `async with dns_pin(...)` 但 dns_pin 是 @contextmanager（同步），
抛 TypeError: '_GeneratorContextManager' object does not support the
asynchronous context manager protocol，导致 image/video task 一进处理就崩。
修复后用 `with dns_pin(...)` 嵌套 `async with httpx.AsyncClient`。
"""

from datetime import datetime, timezone

import pytest

import app.services.worker as worker
from app.models.task import GenerationTask


def _make_task(task_type="image", config=None) -> GenerationTask:
    return GenerationTask(
        id="t1", user_id=1, type=task_type, status="processing",
        prompt="p", config=config or {"channel_id": 1, "model": "m"},
        ref_urls=None, result_url=None, error=None, node_id="n1",
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )


@pytest.mark.asyncio
async def test_process_image_task_no_context_manager_error(monkeypatch):
    """image task 走 dns_pin 路径，不应抛 _GeneratorContextManager TypeError。"""
    # mock channel 查询
    class FakeChannel:
        base_url = "https://api.openai.com"
        api_key = "sk-x"

    async def fake_get_channel(db, cid, uid):
        return FakeChannel()

    import app.crud.model_config as crud_mc
    monkeypatch.setattr(crud_mc, "get_channel", fake_get_channel)

    # mock provider 调用链：_process_image 返回一个 cdn url
    async def fake_process_image(*a, **kw):
        return "https://cdn.example.com/x.png"

    monkeypatch.setattr(worker, "_process_image", fake_process_image)

    # mock download_and_save 返回本地 url
    async def fake_download(*a, **kw):
        return "http://localhost:8000/api/files/1/ab/LOCAL.png"

    monkeypatch.setattr(worker, "download_and_save", fake_download)

    # mock _update_task_status 记录最终状态
    updates = []

    async def fake_update(task_id, status, **kw):
        updates.append((task_id, status, kw))

    monkeypatch.setattr(worker, "_update_task_status", fake_update)

    # mock _resolve_refs
    async def fake_refs(urls):
        return urls or []

    monkeypatch.setattr(worker, "_resolve_refs", fake_refs)

    # 不应抛 TypeError
    await worker._process_task(_make_task("image"))

    # 应走到 completed
    assert any(u[1] == "completed" for u in updates), f"expected completed, got {updates}"


@pytest.mark.asyncio
async def test_process_bg_removal_task_no_context_manager_error(monkeypatch):
    """bg_removal 走 _nullcontext 路径（无 base_url），同样不应抛 TypeError。"""
    async def fake_bg(task):
        return "https://cdn.example.com/y.png"

    monkeypatch.setattr(worker, "_process_bg_removal", fake_bg)

    async def fake_download(*a, **kw):
        return "http://localhost:8000/api/files/1/ab/LOCAL.png"

    monkeypatch.setattr(worker, "download_and_save", fake_download)

    updates = []

    async def fake_update(task_id, status, **kw):
        updates.append((task_id, status))

    monkeypatch.setattr(worker, "_update_task_status", fake_update)

    async def fake_refs(urls):
        return urls or []

    monkeypatch.setattr(worker, "_resolve_refs", fake_refs)

    await worker._process_task(_make_task("bg_removal", config={}))

    assert any(u[1] == "completed" for u in updates), f"expected completed, got {updates}"


@pytest.mark.asyncio
async def test_image_failure_logs_error_once(monkeypatch, caplog):
    """image 处理失败时，error 日志只打一次（不再内层+外层重复）。"""
    import logging
    import httpx

    class FakeChannel:
        base_url = "https://api.openai.com"
        api_key = "sk-x"

    async def fake_get_channel(db, cid, uid):
        return FakeChannel()

    import app.crud.model_config as crud_mc
    monkeypatch.setattr(crud_mc, "get_channel", fake_get_channel)

    async def fake_refs(urls):
        return urls or []

    monkeypatch.setattr(worker, "_resolve_refs", fake_refs)

    # 让真实 _process_image 内的 _post_with_retry 抛连接异常
    async def fake_post_retry(*a, **kw):
        raise httpx.RemoteProtocolError("Server disconnected")

    monkeypatch.setattr(worker, "_post_with_retry", fake_post_retry)

    updates = []

    async def fake_update(task_id, status, **kw):
        updates.append((task_id, status, kw))

    monkeypatch.setattr(worker, "_update_task_status", fake_update)

    caplog.set_level(logging.ERROR, logger="app.services.worker")
    await worker._process_task(_make_task("image"))

    # task 标 failed
    assert any(u[1] == "failed" for u in updates), f"expected failed, got {updates}"

    # "error task=" 只出现一次
    error_lines = [r for r in caplog.records if "error task=" in r.getMessage()]
    assert len(error_lines) == 1, f"expected 1 error log, got {len(error_lines)}: {[r.getMessage() for r in error_lines]}"
    # 不再有旧的 "image failed" 重复日志
    assert not any("image failed" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_download_failure_marks_task_failed(monkeypatch):
    """download_and_save 返回 None（下载/存储失败）时，task 应标 failed 而非 completed。

    旧逻辑：下载失败静默返回外链 url，task 仍标 completed，导致节点 src 是易失效外链、
    capture_frame 等本地功能失效。修复后失败必须标 failed。
    """
    class FakeChannel:
        base_url = "https://api.openai.com"
        api_key = "sk-x"

    async def fake_get_channel(db, cid, uid):
        return FakeChannel()

    import app.crud.model_config as crud_mc
    monkeypatch.setattr(crud_mc, "get_channel", fake_get_channel)

    async def fake_process_image(*a, **kw):
        return "https://cdn.example.com/x.png"  # provider 返回外链

    monkeypatch.setattr(worker, "_process_image", fake_process_image)

    # download_and_save 失败 -> None
    async def fake_download(*a, **kw):
        return None

    monkeypatch.setattr(worker, "download_and_save", fake_download)

    async def fake_refs(urls):
        return urls or []

    monkeypatch.setattr(worker, "_resolve_refs", fake_refs)

    updates = []

    async def fake_update(task_id, status, **kw):
        updates.append((task_id, status, kw))

    monkeypatch.setattr(worker, "_update_task_status", fake_update)

    await worker._process_task(_make_task("image"))

    # 应标 failed，而非 completed
    statuses = [u[1] for u in updates]
    assert "failed" in statuses, f"expected failed, got {statuses}"
    assert "completed" not in statuses, f"should not be completed when download failed, got {statuses}"
    # error 信息含原始 url
    failed = next(u for u in updates if u[1] == "failed")
    assert "下载" in failed[2].get("error", "") or "url" in failed[2].get("error", "")


"""
回归：executor.process_task 的 dns_pin 上下文管理器修复。

之前用 `async with dns_pin(...)` 但 dns_pin 是 @contextmanager（同步），
抛 TypeError: '_GeneratorContextManager' object does not support the
asynchronous context manager protocol，导致 image/video task 一进处理就崩。
修复后用 `with dns_pin(...)` 嵌套 `async with httpx.AsyncClient`。

重构后单任务执行位于 app.services.worker.executor，gateway 分发经
executor._process_via_gateway，测试通过 patch 该函数隔离 Gateway 内部链路。
"""

from contextlib import contextmanager
from datetime import datetime, timezone

import pytest

import app.services.worker.executor as executor
from app.models.task import GenerationTask


def _make_task(task_type="image", config=None, capability="image") -> GenerationTask:
    return GenerationTask(
        id="t1", user_id=1, type=task_type, status="processing",
        capability=capability, protocol="openai",
        prompt="p", config=config or {"channel_id": 1, "model": "m"},
        ref_images=None, error=None, node_id="n1",
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )


def _patch_channel(monkeypatch, base_url="https://api.openai.com"):
    """patch channel 查询 + async_session + SSRF 校验，隔离网络与 DB。"""
    class FakeChannel:
        pass
    FakeChannel.base_url = base_url
    FakeChannel.api_key = "sk-x"
    FakeChannel.protocol = "openai"
    FakeChannel.config = None

    async def fake_get_channel(db, cid, uid):
        return FakeChannel()

    import app.crud.model_config as crud_mc
    monkeypatch.setattr(crud_mc, "get_channel", fake_get_channel)

    class FakeSession:
        async def __aenter__(self, *a):
            return self
        async def __aexit__(self, *a):
            return False
    monkeypatch.setattr(executor, "async_session", lambda: FakeSession())

    # 避免真实 DNS/SSRF 网络解析；保留真实 dns_pin（@contextmanager）以验证 `with` 用法
    monkeypatch.setattr(
        "app.services.ssrf._validate_worker",
        lambda url: ("1.2.3.4", "api.openai.com", "https", 443),
    )

    @contextmanager
    def fake_pin(*a, **k):
        yield
    monkeypatch.setattr("app.services.ssrf.dns_pin", fake_pin)


@pytest.mark.asyncio
async def test_process_image_task_no_context_manager_error(monkeypatch):
    """image task 走 dns_pin 路径，不应抛 _GeneratorContextManager TypeError。"""
    _patch_channel(monkeypatch)

    async def fake_gateway(client, ctx):
        return ["https://cdn.example.com/x.png"], "", {}

    monkeypatch.setattr(executor, "_process_via_gateway", fake_gateway)

    async def fake_download(url, user_id, typ, task_id=""):
        return "http://localhost:8000/api/files/1/ab/LOCAL.png"

    monkeypatch.setattr(executor.StorageService, "download_and_save", staticmethod(fake_download))

    updates = []

    async def fake_update(task_id, status, **kw):
        updates.append((task_id, status, kw))
        return True

    monkeypatch.setattr(executor, "update_task_status", fake_update)

    # 不应抛 TypeError
    await executor.process_task(_make_task("image"))

    # 应走到 completed
    assert any(u[1] == "completed" for u in updates), f"expected completed, got {updates}"


@pytest.mark.asyncio
async def test_process_bg_removal_task_no_context_manager_error(monkeypatch):
    """bg_removal 走 _nullcontext 路径（无 base_url），同样不应抛 TypeError。"""
    async def fake_gateway(client, ctx):
        return ["https://cdn.example.com/y.png"], "", {}

    monkeypatch.setattr(executor, "_process_via_gateway", fake_gateway)

    async def fake_download(url, user_id, typ, task_id=""):
        return "http://localhost:8000/api/files/1/ab/LOCAL.png"

    monkeypatch.setattr(executor.StorageService, "download_and_save", staticmethod(fake_download))

    updates = []

    async def fake_update(task_id, status, **kw):
        updates.append((task_id, status))
        return True

    monkeypatch.setattr(executor, "update_task_status", fake_update)

    await executor.process_task(_make_task("bg_removal", config={}, capability=None))

    assert any(u[1] == "completed" for u in updates), f"expected completed, got {updates}"


@pytest.mark.asyncio
async def test_image_failure_logs_error_once(monkeypatch, caplog):
    """image 处理失败时，error 日志只打一次（不再内层+外层重复）。"""
    import logging
    import httpx

    _patch_channel(monkeypatch)

    async def boom(client, ctx):
        raise httpx.RemoteProtocolError("Server disconnected")

    monkeypatch.setattr(executor, "_process_via_gateway", boom)

    updates = []

    async def fake_update(task_id, status, **kw):
        updates.append((task_id, status, kw))
        return True

    monkeypatch.setattr(executor, "update_task_status", fake_update)

    caplog.set_level(logging.INFO, logger="app.services.worker.executor")
    await executor.process_task(_make_task("image"))

    # task 标 failed
    assert any(u[1] == "failed" for u in updates), f"expected failed, got {updates}"

    # "stage=failed" 只出现一次
    fail_lines = [r for r in caplog.records if "stage=failed" in r.getMessage()]
    assert len(fail_lines) == 1, f"expected 1 failed log, got {len(fail_lines)}: {[r.getMessage() for r in fail_lines]}"


@pytest.mark.asyncio
async def test_download_failure_marks_task_failed(monkeypatch):
    """download_and_save 返回 None（下载/存储失败）时，task 应标 failed 而非 completed。

    旧逻辑：下载失败静默返回外链 url，task 仍标 completed，导致节点 src 是易失效外链、
    capture_frame 等本地功能失效。修复后失败必须标 failed。
    """
    _patch_channel(monkeypatch)

    async def fake_gateway(client, ctx):
        return ["https://cdn.example.com/x.png"], "", {}  # provider 返回外链

    monkeypatch.setattr(executor, "_process_via_gateway", fake_gateway)

    # download_and_save 失败 -> None
    async def fake_download(url, user_id, typ, task_id=""):
        return None

    monkeypatch.setattr(executor.StorageService, "download_and_save", staticmethod(fake_download))

    updates = []

    async def fake_update(task_id, status, **kw):
        updates.append((task_id, status, kw))
        return True

    monkeypatch.setattr(executor, "update_task_status", fake_update)

    await executor.process_task(_make_task("image"))

    # 应标 failed，而非 completed
    statuses = [u[1] for u in updates]
    assert "failed" in statuses, f"expected failed, got {statuses}"
    assert "completed" not in statuses, f"should not be completed when download failed, got {statuses}"
    # error 信息含原始 url
    failed = next(u for u in updates if u[1] == "failed")
    assert "下载" in failed[2].get("error", "") or "url" in failed[2].get("error", "")

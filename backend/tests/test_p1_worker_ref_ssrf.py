"""
P0: worker 生成链路 SSRF 防护（用户可控 ref_urls / source_url）。

- 同源文件 URL → 读本机磁盘转 base64，且不发任何网络请求（消除 hairpin）
- 同源越权（他人 uid）→ 不读盘
- 内网/元数据 URL → 不下载、不 base64 内网内容（透传或拒绝）
- 路径穿越 → 拒绝
- bg_removal 非同源源图 → failed（"must be hosted on this service"）
- bg_removal 同源源图 → 读盘成功、无出网
- _validate_worker 把 HTTPException 转 SSREFError
- channel.base_url 配内网 → task failed（不靠外层 except 兜底，文案清晰）
"""
import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import app.services.worker as worker


# ── _resolve_refs / _read_self_file ────────────────────────────────

@pytest.mark.asyncio
async def test_resolve_refs_self_url_no_network(tmp_path, monkeypatch):
    """同源文件 URL 应直接读盘转 base64，且完全不发起网络请求。"""
    uid = 7
    up = tmp_path / "uploads" / str(uid) / "ab"
    up.mkdir(parents=True)
    content = b"\x89PNG\r\n\x1a\n fake-png-bytes"
    (up / "deadbeef.png").write_bytes(content)
    monkeypatch.setattr("app.services.media.UPLOAD_DIR", str(tmp_path / "uploads"))
    # conftest 未真正重读 env，此处对齐 ssrf 看到的 PUBLIC_URL（测试环境问题，非产品代码）
    from app.services import ssrf
    monkeypatch.setattr(ssrf.settings, "PUBLIC_URL", "http://testserver")

    # 把 worker.httpx 整块替换成 MagicMock：若同源分支仍依赖网络，测试会直接崩
    monkeypatch.setattr(worker, "httpx", MagicMock())

    rel = "http://testserver/api/files/7/ab/deadbeef.png"
    out = await worker._resolve_refs([rel], uid)

    assert len(out) == 1
    assert out[0].startswith("data:image/png;base64,")
    assert base64.b64decode(out[0].split(",", 1)[1]) == content


def test_read_self_file_cross_user_rejected(tmp_path, monkeypatch):
    """同源但属于他人 uid 的 URL 不应被读盘；自身 uid 可读。"""
    up = tmp_path / "uploads" / "7" / "ab"
    up.mkdir(parents=True)
    (up / "deadbeef.png").write_bytes(b"x")
    monkeypatch.setattr("app.services.media.UPLOAD_DIR", str(tmp_path / "uploads"))

    # 他人 uid → None（不读盘）
    assert worker._read_self_file("http://testserver/api/files/8/ab/deadbeef.png", user_id=7) is None
    # 自身 uid → (bytes, mime)
    pair = worker._read_self_file("http://testserver/api/files/7/ab/deadbeef.png", user_id=7)
    assert pair is not None and pair[1] == "image/png"


@pytest.mark.asyncio
async def test_resolve_refs_blocks_internal(tmp_path, monkeypatch):
    """内网/元数据 URL 不应被下载或 base64，原样透传（不泄露内网内容）。"""
    monkeypatch.setattr("app.services.media.UPLOAD_DIR", str(tmp_path / "uploads"))
    for bad in ["http://127.0.0.1:6379/x", "http://169.254.169.254/latest/meta-data/"]:
        out = await worker._resolve_refs([bad], user_id=7)
        assert out == [bad], out
        assert not any(o.startswith("data:") for o in out)


def test_read_self_file_path_traversal(tmp_path, monkeypatch):
    """路径穿越应被拒绝（validate_user_file / realpath 守卫）。"""
    monkeypatch.setattr("app.services.media.UPLOAD_DIR", str(tmp_path / "uploads"))
    rel = "http://testserver/api/files/7/ab/../../etc/passwd"
    assert worker._read_self_file(rel, user_id=7) is None


# ── _process_bg_removal ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_bg_removal_rejects_external_source(monkeypatch):
    """非同源源图 → failed，且根本不会去 fetch 外网。"""
    task = SimpleNamespace(
        id="t1", user_id=7, type="bg_removal",
        ref_urls=["https://evil.com/x.png"], config={}, prompt="",
    )
    monkeypatch.setattr(worker, "_read_self_file", lambda *a, **k: None)
    monkeypatch.setattr("app.services.ssrf.is_self_url", lambda *a, **k: False)
    monkeypatch.setattr("app.services.ssrf.is_allowed_ref_host", lambda *a, **k: False)

    calls = []
    async def fake_update(task_id, status, error=None, result_url=None):
        calls.append((status, error))
    monkeypatch.setattr(worker, "_update_task_status", fake_update)

    res = await worker._process_bg_removal(task)
    assert res is None
    assert calls and calls[0][0] == "failed"
    assert "must be hosted" in (calls[0][1] or "")


@pytest.mark.asyncio
async def test_bg_removal_self_source_reads_disk(monkeypatch):
    """同源源图 → 读盘成功，走到推理服务（可信 INFERENCE_SERVICE_URL），不 fetch 外网。"""
    task = SimpleNamespace(
        id="t1", user_id=7, type="bg_removal",
        ref_urls=["http://testserver/api/files/7/ab/deadbeef.png"], config={}, prompt="",
    )
    monkeypatch.setattr(worker, "_read_self_file", lambda *a, **k: (b"IMGDATA", "image/png"))
    monkeypatch.setattr("app.services.ssrf.is_self_url", lambda *a, **k: True)

    class FakeResp:
        is_success = True
        content = b"\x89PNG result"

    class FakeClient:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, *a, **k):
            return FakeResp()
        async def get(self, *a, **k):
            return FakeResp()

    monkeypatch.setattr(worker.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(worker, "save_upload_bytes",
                        AsyncMock(return_value="http://testserver/api/files/7/result.png"))

    calls = []
    async def fake_update(task_id, status, error=None, result_url=None):
        calls.append((status, result_url))
    monkeypatch.setattr(worker, "_update_task_status", fake_update)

    res = await worker._process_bg_removal(task)
    assert res == "http://testserver/api/files/7/result.png"


# ── _validate_worker 异常处理 ──────────────────────────────────────

def test_validate_worker_converts_http_exception(monkeypatch):
    """_validate_worker 应把 resolve_and_validate 抛的 HTTPException 转成 SSREFError。"""
    from app.services.ssrf import _validate_worker, SSREFError
    from fastapi import HTTPException

    m = MagicMock(side_effect=HTTPException(400, "boom"))
    monkeypatch.setattr("app.services.ssrf.resolve_and_validate", m)

    with pytest.raises(SSREFError):
        _validate_worker("http://x")


# ── _process_task base_url 校验 ────────────────────────────────────

@pytest.mark.asyncio
async def test_process_task_base_url_internal_fails(monkeypatch):
    """channel.base_url 配内网 → task failed（显式 SSREFError 路径，文案清晰）。"""
    task = SimpleNamespace(
        id="t1", user_id=7, type="image",
        ref_urls=[], config={"channel_id": 1, "model": "m"}, prompt="",
    )

    class FakeChannel:
        base_url = "http://10.0.0.5:8080"
        api_key = ""

    async def fake_get_channel(db, cid, uid):
        return FakeChannel()
    monkeypatch.setattr("app.crud.model_config.get_channel", fake_get_channel)

    class FakeSession:
        async def __aenter__(self, *a):
            return self
        async def __aexit__(self, *a):
            return False
    monkeypatch.setattr(worker, "async_session", lambda: FakeSession())

    calls = []
    async def fake_update(task_id, status, error=None, result_url=None):
        calls.append((status, error))
    monkeypatch.setattr(worker, "_update_task_status", fake_update)

    await worker._process_task(task)
    assert calls and calls[0][0] == "failed"
    assert "Invalid provider base_url" in (calls[0][1] or "")

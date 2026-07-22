"""
P1: SSRF 防护接入生成链路。

- 创建/更新 model channel 时 base_url 指向内网/元数据 -> 400
- download_and_save 下载 provider 返回的 url 时，不携带 provider apiKey（凭证泄漏修复）
- 重定向到内网目标 -> SSRFRedirectValidator 拦截
"""

import pytest
import httpx

import app.services.providers.base as base_mod


# ── create_channel / update_channel SSRF ────────────

SSRF_BAD_URLS = [
    "http://127.0.0.1",
    "http://169.254.169.254",  # 云元数据
    "http://192.168.1.1",
    "http://10.0.0.5",
    "http://localhost",
]


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_url", SSRF_BAD_URLS)
async def test_create_channel_rejects_ssrf_url(async_client, bad_url):
    r = await async_client.post(
        "/api/model-config/channels",
        json={"name": "evil", "baseUrl": bad_url, "apiKey": "sk-test"},
    )
    assert r.status_code == 400, f"{bad_url} should be blocked, got {r.status_code}: {r.text}"


@pytest.mark.asyncio
async def test_update_channel_rejects_ssrf_url(async_client):
    """先创建一个合法 channel，再尝试把 baseUrl 改成内网地址 -> 400。"""
    r_create = await async_client.post(
        "/api/model-config/channels",
        json={"name": "ok", "baseUrl": "https://api.openai.com", "apiKey": "sk-x"},
    )
    assert r_create.status_code == 200
    ch_id = r_create.json()["data"]["id"]

    r = await async_client.put(
        f"/api/model-config/channels/{ch_id}",
        json={"baseUrl": "http://169.254.169.254"},
    )
    assert r.status_code == 400, r.text


# ── download_and_save 不泄漏凭证 ────────────────────

@pytest.mark.asyncio
async def test_download_and_save_no_credential_leak(monkeypatch):
    """下载 cdn_url 时发往下载目标的请求头不含 provider apiKey。

    旧实现：401 时用 auth_header 重发，会把 Bearer {apiKey} 发给任意下载目标。
    新实现：download_and_save 签名已移除 auth_header，下载请求永远不带 provider 凭证。
    """
    captured_get_headers = {}
    captured_post_headers = {}

    class FakeResp:
        is_success = True
        content = b"\x89PNG fake"
        status_code = 200
        headers = {}

    class FakeUploadResp:
        is_success = True
        def json(self):
            return {"data": {"url": "http://testserver/api/files/1/ab/saved.png"}}

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kw):
            captured_get_headers.update(kw.get("headers", {}) or {})
            return FakeResp()

        async def post(self, url, **kw):
            captured_post_headers.update(kw.get("headers", {}) or {})
            return FakeUploadResp()

    monkeypatch.setattr(base_mod.httpx, "AsyncClient", FakeClient)
    # 让 _is_self_url 短路失效（强制走下载分支）
    monkeypatch.setattr(base_mod, "_is_self_url", lambda url: False)
    # 跳过真实 DNS 解析（沙箱里 cdn.example.com 解析不到）
    from contextlib import nullcontext
    import app.services.ssrf as ssrf_mod
    monkeypatch.setattr(ssrf_mod, "resolve_and_validate", lambda u: ("1.2.3.4", "cdn.example.com", "https", 443))
    monkeypatch.setattr(ssrf_mod, "dns_pin", lambda *a: nullcontext())

    # 关键：调用签名已无 auth_header 参数
    result = await base_mod.download_and_save(
        "https://cdn.example.com/x.png", "user-jwt", "image"
    )

    # 发往 cdn_url 的 GET 不应带任何 Authorization（provider apiKey 不泄漏）
    assert "Authorization" not in captured_get_headers, \
        f"download GET leaked credentials: {captured_get_headers}"
    # 上传到本服务 POST 才带 user_jwt（这是允许的）
    assert captured_post_headers.get("Authorization") == "Bearer user-jwt"
    assert result.endswith("saved.png")


@pytest.mark.asyncio
async def test_download_and_save_ssrf_block_no_nameerror(monkeypatch):
    """resolve_and_validate 抛 HTTPException（SSRF 拦截）时，download_and_save
    应捕获并返回原 url，不应抛 NameError: HTTPException（base.py 漏 import 的回归）。"""
    from fastapi import HTTPException
    import app.services.ssrf as ssrf_mod

    def raise_ssrf(u):
        raise HTTPException(status_code=400, detail="ssrf blocked")

    monkeypatch.setattr(base_mod, "_is_self_url", lambda url: False)
    monkeypatch.setattr(ssrf_mod, "resolve_and_validate", raise_ssrf)

    # SSRF 拦截 -> 返回 None（让上层标 failed），不再返回原外链 url 蒙混
    result = await base_mod.download_and_save(
        "http://169.254.169.254/x.png", "user-jwt", "image"
    )
    assert result is None


# ── 下载重试 ────────────────────────────────────────


@pytest.mark.asyncio
async def test_download_retry_transport_error_rescued(monkeypatch):
    """第一次连接错误，第二次成功 -> 重试救回，返回本地 url。"""
    from contextlib import nullcontext
    import app.services.ssrf as ssrf_mod
    monkeypatch.setattr(base_mod, "_is_self_url", lambda url: False)
    monkeypatch.setattr(ssrf_mod, "resolve_and_validate", lambda u: ("1.2.3.4", "cdn.example.com", "https", 443))
    monkeypatch.setattr(ssrf_mod, "dns_pin", lambda *a: nullcontext())

    call_count = 0

    class FakeResp:
        is_success = True
        content = b"\x89PNG data"
        status_code = 200
        headers = {}

    class FakeUploadResp:
        is_success = True
        def json(self):
            return {"data": {"url": "http://testserver/api/files/1/ab/retry_rescued.png"}}

    class FakeClient:
        def __init__(self, *a, **kw):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def get(self, url, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise httpx.RemoteProtocolError("Server disconnected")
            return FakeResp()
        async def post(self, url, **kw):
            return FakeUploadResp()

    monkeypatch.setattr(base_mod.httpx, "AsyncClient", FakeClient)
    result = await base_mod.download_and_save("https://cdn.example.com/x.png", "user-jwt", "image")
    assert result is not None
    assert "retry_rescued.png" in result
    assert call_count == 2, f"expected 2 calls (1 fail + 1 retry), got {call_count}"


@pytest.mark.asyncio
async def test_download_retry_503_rescued(monkeypatch):
    """第一次 503，第二次成功 -> 重试救回。"""
    from contextlib import nullcontext
    import app.services.ssrf as ssrf_mod
    monkeypatch.setattr(base_mod, "_is_self_url", lambda url: False)
    monkeypatch.setattr(ssrf_mod, "resolve_and_validate", lambda u: ("1.2.3.4", "cdn.example.com", "https", 443))
    monkeypatch.setattr(ssrf_mod, "dns_pin", lambda *a: nullcontext())

    call_count = 0

    class FakeResp503:
        is_success = False
        status_code = 503
        content = b""
        headers = {}

    class FakeResp200:
        is_success = True
        content = b"\x89PNG data"
        status_code = 200
        headers = {}

    class FakeUploadResp:
        is_success = True
        def json(self):
            return {"data": {"url": "http://testserver/retry_503_rescued.png"}}

    class FakeClient:
        def __init__(self, *a, **kw):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def get(self, url, **kw):
            nonlocal call_count
            call_count += 1
            return FakeResp503() if call_count == 1 else FakeResp200()
        async def post(self, url, **kw):
            return FakeUploadResp()

    monkeypatch.setattr(base_mod.httpx, "AsyncClient", FakeClient)
    result = await base_mod.download_and_save("https://cdn.example.com/x.png", "user-jwt", "image")
    assert result is not None and "retry_503_rescued.png" in result
    assert call_count == 2


@pytest.mark.asyncio
async def test_download_retry_exhausted(monkeypatch):
    """全部重试用尽仍失败 -> 返回 None。"""
    from contextlib import nullcontext
    import app.services.ssrf as ssrf_mod
    monkeypatch.setattr(base_mod, "_is_self_url", lambda url: False)
    monkeypatch.setattr(ssrf_mod, "resolve_and_validate", lambda u: ("1.2.3.4", "cdn.example.com", "https", 443))
    monkeypatch.setattr(ssrf_mod, "dns_pin", lambda *a: nullcontext())

    call_count = 0

    class FakeClient:
        def __init__(self, *a, **kw):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def get(self, url, **kw):
            nonlocal call_count
            call_count += 1
            raise httpx.RemoteProtocolError("Still down")
        async def post(self, url, **kw):
            return None

    monkeypatch.setattr(base_mod.httpx, "AsyncClient", FakeClient)
    result = await base_mod.download_and_save("https://cdn.example.com/x.png", "user-jwt", "image")
    assert result is None
    assert call_count == 3  # 原始 + 2 次重试


@pytest.mark.asyncio
async def test_download_does_not_retry_404(monkeypatch):
    """4xx 不重试，直接返回 None。"""
    from contextlib import nullcontext
    import app.services.ssrf as ssrf_mod
    monkeypatch.setattr(base_mod, "_is_self_url", lambda url: False)
    monkeypatch.setattr(ssrf_mod, "resolve_and_validate", lambda u: ("1.2.3.4", "cdn.example.com", "https", 443))
    monkeypatch.setattr(ssrf_mod, "dns_pin", lambda *a: nullcontext())

    call_count = 0

    class FakeResp404:
        is_success = False
        status_code = 404
        content = b""
        headers = {}

    class FakeClient:
        def __init__(self, *a, **kw):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def get(self, url, **kw):
            nonlocal call_count
            call_count += 1
            return FakeResp404()
        async def post(self, url, **kw):
            return None

    monkeypatch.setattr(base_mod.httpx, "AsyncClient", FakeClient)
    result = await base_mod.download_and_save("https://cdn.example.com/not-found.png", "user-jwt", "image")
    assert result is None
    assert call_count == 1  # 只试一次，不重试

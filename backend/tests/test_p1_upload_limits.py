"""
P1: 上传大小限制 + magic bytes 校验。

- 超过 MAX_UPLOAD_SIZE_MB -> 413（分块读，避免 OOM）
- content_type 伪造（声称 image/png 但内容非图片）-> 400（magic bytes 白名单）
- 真实 PNG -> 正常 200（sniff 不误伤）
"""

import pytest

import app.config as app_config


@pytest.mark.asyncio
async def test_upload_rejects_oversize(async_client, monkeypatch):
    """超过上限应返回 413。"""
    monkeypatch.setattr(app_config.settings, "MAX_UPLOAD_SIZE_MB", 1)
    from conftest import sample_png_bytes

    base = sample_png_bytes()
    big = base + b"\x00" * (2 * 1024 * 1024)  # 2MB，以 PNG 头开头（避免 sniff 干扰）
    r = await async_client.post(
        "/api/files/upload?category=images",
        files={"file": ("big.png", big, "image/png")},
    )
    assert r.status_code == 413, r.text


@pytest.mark.asyncio
async def test_upload_rejects_fake_content_type(async_client):
    """content_type 声称 image/png 但内容非图片，应被 magic bytes 拒绝（400）。"""
    r = await async_client.post(
        "/api/files/upload?category=images",
        files={"file": ("evil.png", b"alert(1)", "image/png")},
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_upload_accepts_real_png(async_client):
    """真实 PNG 应正常通过 sniff。"""
    from conftest import sample_png_bytes

    r = await async_client.post(
        "/api/files/upload?category=images",
        files={"file": ("ok.png", sample_png_bytes(), "image/png")},
    )
    assert r.status_code == 200, r.text

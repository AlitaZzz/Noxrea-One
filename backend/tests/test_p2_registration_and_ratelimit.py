"""
P2: 注册开关 + 限流。

- ALLOW_REGISTRATION=false 时 /register 返回 403
- login 同 IP 5 分钟超 10 次 -> 429
- register 同 IP 1 小时超 5 次 -> 429
"""

import pytest

import app.services.ratelimit as ratelimit


@pytest.fixture(autouse=True)
def _reset_ratelimit():
    ratelimit.reset()
    yield
    ratelimit.reset()


@pytest.mark.asyncio
async def test_registration_disabled(async_client, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "ALLOW_REGISTRATION", False)
    r = await async_client.post("/api/auth/register",
                                json={"username": "newuser", "password": "pw123456"})
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_registration_enabled_by_default(async_client):
    """默认开启注册：用一个不存在的用户名应能成功（或 409 重名，都不应是 403）。"""
    r = await async_client.post("/api/auth/register",
                                json={"username": "open_reg_user", "password": "pw123456"})
    assert r.status_code in (200, 409)


@pytest.mark.asyncio
async def test_login_rate_limit(async_client):
    """连续 11 次登录尝试，第 11 次应 429。"""
    for _ in range(10):
        await async_client.post("/api/auth/login",
                                json={"username": "admin", "password": "wrong"})
    r = await async_client.post("/api/auth/login",
                                json={"username": "admin", "password": "wrong"})
    assert r.status_code == 429

"""
test_supplement_3_model_config_isolation — model_config 跨用户隔离。

验证用户 B 无法通过已知 ID 操作用户 A 的 channel 或 model。
"""

import pytest
from contextlib import nullcontext
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text as _sql
from sqlalchemy.ext.asyncio import AsyncSession

from app.main import app
from app.deps import get_current_user
from app.models.user import User
import app.services.ssrf as ssrf_mod


@pytest.fixture(autouse=True)
def _bypass_ssrf(monkeypatch):
    """本文件测跨用户隔离，与 SSRF 无关；跳过真实 DNS 解析避免依赖外网。"""
    monkeypatch.setattr(
        ssrf_mod, "resolve_and_validate",
        lambda u: ("1.2.3.4", "test.example.com", "https", 443),
    )
    monkeypatch.setattr(ssrf_mod, "dns_pin", lambda *a: nullcontext())


@pytest.mark.asyncio
async def test_user_b_cannot_access_user_a_channel(
    db: AsyncSession,
    async_client: AsyncClient,
):
    """User A 创建 channel，User B 尝试访问/修改应返回 404。"""
    from app.services.auth import hash_password, create_access_token

    # User A creates a channel
    resp = await async_client.post("/api/model-config/channels", json={
        "name": "Alice's Channel", "baseUrl": "http://alice.example.com", "apiKey": "sk-alice",
    })
    assert resp.status_code == 200
    channel_id = resp.json()["data"]["id"]

    # Create user B
    pw = hash_password("user-b-pass")
    await db.execute(
        _sql("INSERT INTO users (username, password_hash, role) VALUES ('user_b', :pw, 'user')"),
        {"pw": pw},
    )
    await db.commit()
    r = await db.execute(_sql("SELECT id FROM users WHERE username = 'user_b'"))
    user_b_id = r.fetchone()[0]
    token_b = create_access_token({"sub": str(user_b_id)})

    async def _get_user_b():
        r2 = await db.execute(
            _sql("SELECT id, username, password_hash, role FROM users WHERE id = :uid"),
            {"uid": user_b_id},
        )
        row = r2.fetchone()
        return User(id=row[0], username=row[1], password_hash=row[2], role=row[3])

    # Switch to user B
    app.dependency_overrides[get_current_user] = _get_user_b

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver", headers={"Authorization": f"Bearer {token_b}"}) as cli:
        # B sees zero channels
        resp_b = await cli.get("/api/model-config/channels")
        assert resp_b.status_code == 200
        assert len(resp_b.json()["data"]) == 0

        # B cannot update
        resp_b = await cli.put(f"/api/model-config/channels/{channel_id}", json={"name": "hacked"})
        assert resp_b.status_code == 404

        # B cannot delete
        resp_b = await cli.delete(f"/api/model-config/channels/{channel_id}")
        assert resp_b.status_code == 404

        # B cannot add model
        resp_b = await cli.post(f"/api/model-config/channels/{channel_id}/models", json={"name": "evil-model"})
        assert resp_b.status_code == 404

        # B cannot set models
        resp_b = await cli.post(f"/api/model-config/channels/{channel_id}/models/set", json={"models": []})
        assert resp_b.status_code == 404

        # B cannot toggle capability
        resp_b = await cli.put(f"/api/model-config/channels/{channel_id}/models/999/capability", json={"capabilities": ["text"]})
        assert resp_b.status_code == 404


@pytest.mark.asyncio
async def test_model_cross_user_isolation(
    db: AsyncSession,
    async_client: AsyncClient,
):
    """User A 创建 channel + model，User B 无法操作该 model。"""
    from app.services.auth import hash_password, create_access_token

    # User A creates channel + model
    resp = await async_client.post("/api/model-config/channels", json={
        "name": "Alice Channel", "baseUrl": "http://a.com", "apiKey": "sk-a",
    })
    channel_id = resp.json()["data"]["id"]

    resp = await async_client.post(f"/api/model-config/channels/{channel_id}/models", json={
        "name": "gpt-4", "capabilities": ["text", "image"],
    })
    model_id = resp.json()["data"]["id"]

    # Create user B
    pw = hash_password("user-b-pass")
    await db.execute(
        _sql("INSERT INTO users (username, password_hash, role) VALUES ('user_b', :pw, 'user')"),
        {"pw": pw},
    )
    await db.commit()
    r = await db.execute(_sql("SELECT id FROM users WHERE username = 'user_b'"))
    user_b_id = r.fetchone()[0]
    token_b = create_access_token({"sub": str(user_b_id)})

    async def _get_user_b():
        r2 = await db.execute(
            _sql("SELECT id, username, password_hash, role FROM users WHERE id = :uid"),
            {"uid": user_b_id},
        )
        row = r2.fetchone()
        return User(id=row[0], username=row[1], password_hash=row[2], role=row[3])

    app.dependency_overrides[get_current_user] = _get_user_b

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver", headers={"Authorization": f"Bearer {token_b}"}) as cli:
        # B cannot toggle capability
        resp_b = await cli.put(
            f"/api/model-config/channels/{channel_id}/models/{model_id}/capability",
            json={"capabilities": ["text"]},
        )
        assert resp_b.status_code == 404

        # B cannot delete model
        resp_b = await cli.delete(f"/api/model-config/channels/{channel_id}/models/{model_id}")
        assert resp_b.status_code == 404

"""
P2: API key 掩码回显 + 代理接口走 channel_id。

- list_channels 返回的 apiKey 是掩码（sk-***末4位），非明文
- update_channel 传掩码或空字符串 -> 保留原 key 不被覆盖
- update_channel 传新明文 -> 更新
- 代理接口 /api/chat/completions、/api/models/list 改为接收 channelId（前端不再持明文 key）
"""

import pytest
from contextlib import nullcontext
from sqlalchemy import text as _sql

import app.services.ssrf as ssrf_mod


@pytest.fixture(autouse=True)
def _bypass_ssrf(monkeypatch):
    """跳过真实 DNS 解析（沙箱里 api.openai.com 解析不到）。"""
    monkeypatch.setattr(
        ssrf_mod, "resolve_and_validate",
        lambda u: ("1.2.3.4", "test.example.com", "https", 443),
    )
    monkeypatch.setattr(ssrf_mod, "dns_pin", lambda *a: nullcontext())


@pytest.mark.asyncio
async def test_list_channels_masks_apikey(async_client):
    """list_channels 返回的 apiKey 应为掩码，不含原始明文。"""
    r = await async_client.post(
        "/api/model-config/channels",
        json={"name": "mk", "baseUrl": "https://api.openai.com", "apiKey": "sk-secret-abcdef1234"},
    )
    assert r.status_code == 200
    ch_id = r.json()["data"]["id"]

    r = await async_client.get("/api/model-config/channels")
    assert r.status_code == 200
    ch = next(c for c in r.json()["data"] if c["id"] == ch_id)
    # 掩码：保留末4位，明文整体不应出现
    assert ch["apiKey"] == "sk-***1234"
    assert "secret" not in ch["apiKey"]
    assert "abcdef" not in ch["apiKey"]


@pytest.mark.asyncio
async def test_update_channel_empty_apikey_keeps_original(async_client, db):
    """编辑时 apiKey 留空（前端不预填）-> 保留原 key，不被空串覆盖。"""
    r = await async_client.post(
        "/api/model-config/channels",
        json={"name": "keep", "baseUrl": "https://api.openai.com", "apiKey": "sk-original-xxxx"},
    )
    ch_id = r.json()["data"]["id"]

    # 只改名字，apiKey 传空
    r = await async_client.put(
        f"/api/model-config/channels/{ch_id}",
        json={"name": "keep-renamed", "apiKey": ""},
    )
    assert r.status_code == 200

    # DB 里真 key 应仍是原值
    row = (await db.execute(
        _sql("SELECT api_key FROM model_channels WHERE id = :id"), {"id": int(ch_id)}
    )).scalar()
    assert row == "sk-original-xxxx"


@pytest.mark.asyncio
async def test_update_channel_masked_apikey_keeps_original(async_client, db):
    """编辑时 apiKey 传回掩码值（误填）-> 仍保留原 key。"""
    r = await async_client.post(
        "/api/model-config/channels",
        json={"name": "mk2", "baseUrl": "https://api.openai.com", "apiKey": "sk-secret-9999"},
    )
    ch_id = r.json()["data"]["id"]

    # 传回掩码（模拟前端若预填了掩码又保存）
    r = await async_client.put(
        f"/api/model-config/channels/{ch_id}",
        json={"apiKey": "sk-***9999"},
    )
    assert r.status_code == 200

    row = (await db.execute(
        _sql("SELECT api_key FROM model_channels WHERE id = :id"), {"id": int(ch_id)}
    )).scalar()
    assert row == "sk-secret-9999"  # 未被掩码覆盖


@pytest.mark.asyncio
async def test_update_channel_new_apikey_updates(async_client, db):
    """编辑时传入新明文 -> 更新为新 key。"""
    r = await async_client.post(
        "/api/model-config/channels",
        json={"name": "mk3", "baseUrl": "https://api.openai.com", "apiKey": "sk-old-aaaa"},
    )
    ch_id = r.json()["data"]["id"]

    r = await async_client.put(
        f"/api/model-config/channels/{ch_id}",
        json={"apiKey": "sk-new-bbbb"},
    )
    assert r.status_code == 200

    row = (await db.execute(
        _sql("SELECT api_key FROM model_channels WHERE id = :id"), {"id": int(ch_id)}
    )).scalar()
    assert row == "sk-new-bbbb"

"""
P2: 轻量加固。

- generate task 的 n 被限幅到 [1,4]（防放大计费）
- SSE 流在客户端断连后退出（不堆积连接）
"""

import asyncio

import pytest

from app.routers.generate import create_task


@pytest.mark.asyncio
async def test_n_clamped_to_range(monkeypatch):
    """n=999 应被 clamp 到 4；n=0 clamp 到 1。"""
    captured = {}

    class FakeUser:
        id = 1

    class FakeChannel:
        pass

    async def fake_get_channel(db, cid, uid):
        return FakeChannel()

    async def fake_create_task(db, task_id, user_id, ttype, prompt, config, ref_urls, node_id, now):
        captured["config"] = config
        # 返回一个最小可 model_validate 的对象
        class T:
            pass
        t = T()
        t.id = task_id
        t.user_id = user_id
        t.type = ttype
        t.status = "pending"
        t.prompt = prompt
        t.config = config
        t.ref_urls = ref_urls
        t.node_id = node_id
        t.created_at = now
        t.updated_at = now
        return t

    import app.routers.generate as gen_mod
    monkeypatch.setattr(gen_mod.crud_model_config, "get_channel", fake_get_channel)
    monkeypatch.setattr(gen_mod.crud, "create_task", fake_create_task)

    from app.schemas.task import TaskOut

    # n=999 -> 4
    await create_task({"type": "image", "prompt": "x", "channelId": "1", "n": 999}, user=FakeUser())
    assert captured["config"]["n"] == 4

    # n=0 -> 1
    await create_task({"type": "image", "prompt": "x", "channelId": "1", "n": 0}, user=FakeUser())
    assert captured["config"]["n"] == 1

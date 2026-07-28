"""
模型列表代理接口 - 带鉴权和 SSRF 防护的转发层。

  - POST /api/models/list -> {channel 的 baseUrl}/models

按 channel_id 取该用户 channel 的 baseUrl/apiKey 转发，前端不再持有明文 apiKey。
所有接口均需 JWT 鉴权 (Depends(get_current_user))。
SSRF 防护逻辑统一在 app.services.ssrf。
"""

import json
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_current_user, get_db
from app.schemas.common import UnifiedResponse
from app.services.ssrf import resolve_and_validate, dns_pin
from app.services.model_capabilities import infer_capabilities, load_records, load_whitelist
from app.services.http import TIMEOUT_API
from app.crud import model_config as crud_model_config

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/models", tags=["models"])


# ── 请求体 ──────────────────────────────────────────

class ModelListRequest(BaseModel):
    channelId: str


async def _resolve_channel(db: AsyncSession, channel_id: str, user_id: int):
    """取当前用户的 channel 并 SSRF 校验 baseUrl，返回 (base_url, api_key, ip, hostname, port)。"""
    try:
        cid = int(channel_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid channelId")
    channel = await crud_model_config.get_channel(db, cid, user_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    ip, hostname, scheme, port = resolve_and_validate(channel.base_url)
    return channel.base_url, channel.api_key, ip, hostname, port


# ── 接口 ────────────────────────────────────────────

@router.post("/list")
async def models_list(
    body: ModelListRequest,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    base_url, api_key, ip, hostname, port = await _resolve_channel(db, body.channelId, user.id)
    logger.debug(f"models list proxy user={user.id} host={hostname}")

    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    url = base_url.rstrip("/")

    with dns_pin(hostname, ip, port):
        async with httpx.AsyncClient(
            timeout=TIMEOUT_API,
            follow_redirects=False,
        ) as client:
            try:
                res = await client.get(f"{url}/models", headers=headers)
                try:
                    data = res.json()
                except json.JSONDecodeError:
                    return UnifiedResponse(
                        code=502,
                        data=None,
                        msg=f"上游返回非 JSON（{res.status_code}），请检查 channel baseUrl 是否包含 /v1。当前 baseUrl: {url}",
                    )
                if not res.is_success:
                    return UnifiedResponse(
                        code=res.status_code,
                        data=None,
                        msg=data.get("error", {}).get("message", str(res.status_code)),
                    )
                models = data.get("data", data) if isinstance(data, dict) else data
                # 能力推断：仅附加 suggestedCapabilities / capSource 建议字段，
                # 不改变上游返回，也不自动勾取能力。
                if isinstance(models, list):
                    # 拉取时各读取一次本地库与白名单进内存，后续每个模型在内存中匹配
                    records = load_records()
                    whitelist = load_whitelist()
                    for m in models:
                        if isinstance(m, dict):
                            nm = m.get("id") or m.get("name")
                            if nm:
                                info = infer_capabilities(str(nm), records, whitelist)
                                m["suggestedCapabilities"] = info["suggested"]
                                m["capSource"] = info["source"]
                count = len(models) if isinstance(models, list) else "n/a"
                logger.info(f"models list upstream status={res.status_code} user={user.id} host={hostname} count={count}")
                return UnifiedResponse(code=200, data=models, msg="ok")
            except httpx.RequestError as e:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Failed to reach AI provider: {e}",
                )

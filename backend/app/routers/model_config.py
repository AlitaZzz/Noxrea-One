from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.common import UnifiedResponse
from app.schemas.model_config import ModelChannelCreate, ModelChannelUpdate, ModelInfoCreate, ModelModelsSet, ModelCapabilityUpdate
from app.deps import get_db, get_current_user
from app.crud import model_config as crud

router = APIRouter(prefix="/api/model-config", tags=["model-config"])


@router.get("/channels")
async def list_channels(
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    channels = await crud.get_channels(db, user.id)
    data = []
    for ch in channels:
        data.append({
            "id": str(ch.id), "name": ch.name, "baseUrl": ch.base_url,
            "apiKey": crud.mask_api_key(ch.api_key),  # 掩码回显，避免明文泄漏
            "models": [{"id": str(m.id), "name": m.name, "capabilities": m.capabilities or []} for m in ch.models],
        })
    return UnifiedResponse(code=200, data=data, msg="ok")


@router.post("/channels")
async def create_channel(
    body: ModelChannelCreate,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # SSRF：创建时即校验 base_url，尽早拒绝内网/元数据地址（机制同 ai_proxy）
    from app.services.ssrf import resolve_and_validate
    resolve_and_validate(body.baseUrl)
    ch = await crud.create_channel(db, user.id, body.name, body.baseUrl, body.apiKey)
    return UnifiedResponse(code=200, data={"id": str(ch.id)}, msg="created")


@router.put("/channels/{channel_id}")
async def update_channel(
    channel_id: str,
    body: ModelChannelUpdate,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # SSRF：更新时同样校验（用户可借修改 base_url 绕过创建校验）
    from app.services.ssrf import resolve_and_validate
    if body.baseUrl:
        resolve_and_validate(body.baseUrl)
    # apiKey：前端编辑时预填的是掩码值，"未改动/留空"应保留原值，避免把掩码字符串写回覆盖真 key
    existing = await crud.get_channel(db, int(channel_id), user.id)
    if not existing:
        raise HTTPException(status_code=404, detail="Not found")
    new_api_key = None if crud.is_masked_or_empty(body.apiKey, existing.api_key) else body.apiKey
    ch = await crud.update_channel(
        db, int(channel_id), user.id,
        name=body.name, base_url=body.baseUrl, api_key=new_api_key,
    )
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    return UnifiedResponse(code=200, msg="updated")


@router.delete("/channels/{channel_id}")
async def delete_channel(
    channel_id: str,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ok = await crud.delete_channel(db, int(channel_id), user.id)
    if not ok:
        raise HTTPException(status_code=404, detail="Not found")
    return UnifiedResponse(code=200, msg="deleted")


@router.post("/channels/{channel_id}/models")
async def add_model(
    channel_id: str,
    body: ModelInfoCreate,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ch = await crud.get_channel(db, int(channel_id), user.id)
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    m = await crud.add_model(db, int(channel_id), body.name, body.capabilities)
    return UnifiedResponse(code=200, data={"id": str(m.id)}, msg="added")


@router.delete("/channels/{channel_id}/models/{model_id}")
async def remove_model(
    channel_id: str,
    model_id: str,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ch = await crud.get_channel(db, int(channel_id), user.id)
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    await crud.remove_model(db, int(model_id), int(channel_id))
    return UnifiedResponse(code=200, msg="deleted")


@router.post("/channels/{channel_id}/models/set")
async def set_models(
    channel_id: str,
    body: ModelModelsSet,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ch = await crud.get_channel(db, int(channel_id), user.id)
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    models_data = [m.model_dump() for m in body.models]
    await crud.set_models(db, int(channel_id), models_data)
    return UnifiedResponse(code=200, msg="updated")


@router.put("/channels/{channel_id}/models/{model_id}/capability")
async def toggle_capability(
    channel_id: str,
    model_id: str,
    body: ModelCapabilityUpdate,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ch = await crud.get_channel(db, int(channel_id), user.id)
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    m = await crud.update_model_capabilities(db, int(model_id), int(channel_id), body.capabilities)
    if not m:
        raise HTTPException(status_code=404, detail="Not found")
    return UnifiedResponse(code=200, msg="updated")

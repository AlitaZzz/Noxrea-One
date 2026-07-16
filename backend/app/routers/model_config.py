from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.schemas.common import UnifiedResponse
from app.deps import get_db, get_current_user
from app.models.model_config import ModelChannel, ModelInfo

router = APIRouter(prefix="/api/model-config", tags=["model-config"])


@router.get("/channels")
async def list_channels(
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ModelChannel).where(ModelChannel.user_id == user.id).options(selectinload(ModelChannel.models)).order_by(ModelChannel.updated_at.desc())
    )
    channels = result.scalars().all()
    data = []
    for ch in channels:
        data.append({
            "id": str(ch.id), "name": ch.name, "baseUrl": ch.base_url, "apiKey": ch.api_key,
            "models": [{"id": str(m.id), "name": m.name, "capabilities": m.capabilities or []} for m in ch.models],
        })
    return UnifiedResponse(code=200, data=data, msg="ok")


@router.post("/channels")
async def create_channel(
    body: dict,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ch = ModelChannel(user_id=user.id, name=body.get("name", ""), base_url=body.get("baseUrl", ""), api_key=body.get("apiKey", ""))
    db.add(ch)
    await db.commit()
    await db.refresh(ch)
    return UnifiedResponse(code=200, data={"id": str(ch.id)}, msg="created")


@router.put("/channels/{channel_id}")
async def update_channel(
    channel_id: str,
    body: dict,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(ModelChannel).where(ModelChannel.id == int(channel_id), ModelChannel.user_id == user.id))
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    if "name" in body: ch.name = body["name"]
    if "baseUrl" in body: ch.base_url = body["baseUrl"]
    if "apiKey" in body: ch.api_key = body["apiKey"]
    await db.commit()
    return UnifiedResponse(code=200, msg="updated")


@router.delete("/channels/{channel_id}")
async def delete_channel(
    channel_id: str,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(ModelChannel).where(ModelChannel.id == int(channel_id), ModelChannel.user_id == user.id))
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    await db.delete(ch)
    await db.commit()
    return UnifiedResponse(code=200, msg="deleted")


@router.post("/channels/{channel_id}/models")
async def add_model(
    channel_id: str,
    body: dict,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(ModelChannel).where(ModelChannel.id == int(channel_id), ModelChannel.user_id == user.id))
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    m = ModelInfo(channel_id=int(channel_id), name=body.get("name", ""), capabilities=body.get("capabilities", []))
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return UnifiedResponse(code=200, data={"id": str(m.id)}, msg="added")


@router.delete("/channels/{channel_id}/models/{model_id}")
async def remove_model(
    channel_id: str,
    model_id: str,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(ModelChannel).where(ModelChannel.id == int(channel_id), ModelChannel.user_id == user.id))
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    m_result = await db.execute(select(ModelInfo).where(ModelInfo.id == int(model_id), ModelInfo.channel_id == int(channel_id)))
    m = m_result.scalar_one_or_none()
    if m:
        await db.delete(m)
        await db.commit()
    return UnifiedResponse(code=200, msg="deleted")


@router.post("/channels/{channel_id}/models/set")
async def set_models(
    channel_id: str,
    body: dict,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(ModelChannel).where(ModelChannel.id == int(channel_id), ModelChannel.user_id == user.id))
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    await db.execute(delete(ModelInfo).where(ModelInfo.channel_id == int(channel_id)))
    for m_data in body.get("models", []):
        m = ModelInfo(channel_id=int(channel_id), name=m_data["name"], capabilities=m_data.get("capabilities", []))
        db.add(m)
    await db.commit()
    return UnifiedResponse(code=200, msg="updated")


@router.put("/channels/{channel_id}/models/{model_id}/capability")
async def toggle_capability(
    channel_id: str,
    model_id: str,
    body: dict,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    m_result = await db.execute(select(ModelInfo).where(ModelInfo.id == int(model_id), ModelInfo.channel_id == int(channel_id)))
    m = m_result.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Not found")
    m.capabilities = body.get("capabilities", m.capabilities)
    await db.commit()
    return UnifiedResponse(code=200, msg="updated")

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.common import UnifiedResponse
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
    ch = await crud.create_channel(db, user.id, body.get("name", ""), body.get("baseUrl", ""), body.get("apiKey", ""))
    return UnifiedResponse(code=200, data={"id": str(ch.id)}, msg="created")


@router.put("/channels/{channel_id}")
async def update_channel(
    channel_id: str,
    body: dict,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ch = await crud.update_channel(
        db, int(channel_id), user.id,
        name=body.get("name"), base_url=body.get("baseUrl"), api_key=body.get("apiKey"),
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
    body: dict,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ch = await crud.get_channel(db, int(channel_id), user.id)
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    m = await crud.add_model(db, int(channel_id), body.get("name", ""), body.get("capabilities", []))
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
    body: dict,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ch = await crud.get_channel(db, int(channel_id), user.id)
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    await crud.set_models(db, int(channel_id), body.get("models", []))
    return UnifiedResponse(code=200, msg="updated")


@router.put("/channels/{channel_id}/models/{model_id}/capability")
async def toggle_capability(
    channel_id: str,
    model_id: str,
    body: dict,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ch = await crud.get_channel(db, int(channel_id), user.id)
    if not ch:
        raise HTTPException(status_code=404, detail="Not found")
    m = await crud.update_model_capabilities(db, int(model_id), int(channel_id), body.get("capabilities", []))
    if not m:
        raise HTTPException(status_code=404, detail="Not found")
    return UnifiedResponse(code=200, msg="updated")

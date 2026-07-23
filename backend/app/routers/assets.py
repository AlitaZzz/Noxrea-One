from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.common import UnifiedResponse
from app.schemas.asset import (
    AssetFolderCreate,
    AssetFolderUpdate,
    AssetFolderOut,
    AssetCreate,
    AssetUpdate,
    AssetOut,
)
from app.deps import get_db, get_current_user
from app.crud import asset as crud

router = APIRouter(prefix="/api/assets", tags=["assets"])


# --- Folders ---

@router.get("/folders", response_model=UnifiedResponse[list[AssetFolderOut]])
async def list_folders(
    space_key: str = Query("personal"),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    folders = await crud.get_folders(db, user.id, space_key)
    return UnifiedResponse(
        code=200,
        data=[AssetFolderOut.model_validate(f) for f in folders],
        msg="ok",
    )


@router.post("/folders", response_model=UnifiedResponse[AssetFolderOut])
async def create_folder(
    body: AssetFolderCreate,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    folder = await crud.create_folder(db, user.id, body.name, body.space_key, body.parent_id)
    if not folder:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Folder with this name already exists at this level",
        )
    return UnifiedResponse(code=200, data=AssetFolderOut.model_validate(folder), msg="created")


@router.put("/folders/{folder_id}", response_model=UnifiedResponse[AssetFolderOut])
async def update_folder(
    folder_id: int,
    body: AssetFolderUpdate,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    if not body.name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Name is required")
    folder = await crud.update_folder(db, folder_id, body.name, user.id)
    if not folder:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
    return UnifiedResponse(code=200, data=AssetFolderOut.model_validate(folder), msg="updated")


@router.delete("/folders/{folder_id}", response_model=UnifiedResponse)
async def delete_folder(
    folder_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    ok = await crud.delete_folder(db, folder_id, user.id)
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
    return UnifiedResponse(code=200, msg="deleted")


@router.put("/items/batch", response_model=UnifiedResponse)
async def update_assets_batch(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """Batch update assets: { ids: [1,2,3], updates: { folder_id: 5, type: "character" } }"""
    ids = body.get("ids", [])
    updates = body.get("updates", {})
    if not ids or not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="ids and updates required")
    count = await crud.update_assets_batch(db, ids, user.id, updates)
    return UnifiedResponse(code=200, data={"count": count}, msg="updated")


# --- Assets ---

@router.get("/items", response_model=UnifiedResponse[dict])
async def list_assets(
    folder_id: Optional[int] = Query(None),
    asset_type: Optional[str] = Query(None, alias="type"),
    search: Optional[str] = Query(None),
    space_key: Optional[str] = Query(None),
    skip: int = Query(0),
    limit: int = Query(200),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    assets = await crud.get_assets(db, user.id, folder_id, asset_type, search, space_key=space_key, skip=skip, limit=limit)
    total = await crud.count_assets(db, user.id, folder_id, asset_type, search, space_key=space_key)
    return UnifiedResponse(
        code=200,
        data={
            "items": [AssetOut.model_validate(a).model_dump(mode="json") for a in assets],
            "total": total,
        },
        msg="ok",
    )


@router.get("/items/source-urls", response_model=UnifiedResponse[list[str]])
async def list_source_urls(
    space_key: str = Query("personal"),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    urls = await crud.get_asset_source_urls(db, user.id, space_key)
    return UnifiedResponse(code=200, data=urls, msg="ok")


@router.get("/items/{asset_id}", response_model=UnifiedResponse[AssetOut])
async def get_asset(
    asset_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    asset = await crud.get_asset(db, asset_id, user.id)
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    return UnifiedResponse(code=200, data=AssetOut.model_validate(asset), msg="ok")


@router.post("/items", response_model=UnifiedResponse[AssetOut])
async def create_asset(
    body: AssetCreate,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    asset = await crud.create_asset(
        db, user.id,
        name=body.name, type=body.type,
        width=body.width, height=body.height,
        description=body.description, tags=body.tags, extra_data=body.extra_data,
        folder_id=body.folder_id, space_key=body.space_key,
    )
    return UnifiedResponse(code=200, data=AssetOut.model_validate(asset), msg="created")


@router.post("/items/batch", response_model=UnifiedResponse[list[AssetOut]])
async def create_assets_batch(
    body: list[AssetCreate],
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    items = [
        dict(name=b.name, type=b.type, width=b.width, height=b.height,
             description=b.description, tags=b.tags, extra_data=b.extra_data, folder_id=b.folder_id)
        for b in body
    ]
    assets = await crud.create_assets_batch(db, user.id, items)
    return UnifiedResponse(
        code=200,
        data=[AssetOut.model_validate(a) for a in assets],
        msg="created",
    )


@router.put("/items/{asset_id}", response_model=UnifiedResponse[AssetOut])
async def update_asset(
    asset_id: int,
    body: AssetUpdate,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    asset = await crud.update_asset(
        db, asset_id, user.id,
        name=body.name, type=body.type,
        width=body.width, height=body.height,
        description=body.description, tags=body.tags, folder_id=body.folder_id,
    )
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    return UnifiedResponse(code=200, data=AssetOut.model_validate(asset), msg="updated")


@router.delete("/items/{asset_id}", response_model=UnifiedResponse)
async def delete_asset(
    asset_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    ok = await crud.delete_asset(db, asset_id, user.id)
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    return UnifiedResponse(code=200, msg="deleted")

from typing import Optional, Sequence

from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import AssetItem, AssetFolder


# --- Folder CRUD ---

async def get_folders(db: AsyncSession, user_id: int, space_key: str) -> Sequence[AssetFolder]:
    q = select(AssetFolder).where(
        AssetFolder.user_id == user_id,
        AssetFolder.space_key == space_key,
    ).order_by(AssetFolder.name)
    result = await db.execute(q)
    return result.scalars().all()


async def get_folder(db: AsyncSession, folder_id: int, user_id: int) -> Optional[AssetFolder]:
    result = await db.execute(
        select(AssetFolder).where(AssetFolder.id == folder_id, AssetFolder.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def create_folder(
    db: AsyncSession, user_id: int, name: str, space_key: str, parent_id: Optional[int] = None
) -> Optional[AssetFolder]:
    # Check duplicate at same level
    q = select(AssetFolder).where(
        AssetFolder.user_id == user_id,
        AssetFolder.space_key == space_key,
        AssetFolder.parent_id == parent_id,
        AssetFolder.name == name,
    )
    r = await db.execute(q)
    if r.scalar_one_or_none():
        return None

    folder = AssetFolder(user_id=user_id, name=name, space_key=space_key, parent_id=parent_id)
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return folder


async def update_folder(db: AsyncSession, folder_id: int, name: str, user_id: int) -> Optional[AssetFolder]:
    folder = await get_folder(db, folder_id, user_id)
    if not folder:
        return None
    folder.name = name
    await db.commit()
    await db.refresh(folder)
    return folder


async def delete_folder(db: AsyncSession, folder_id: int, user_id: int) -> bool:
    folder = await get_folder(db, folder_id, user_id)
    if not folder:
        return False
    # Cascade sets child folders' parent_id to NULL (via FK ondelete SET NULL)
    await db.delete(folder)
    await db.commit()
    return True


# --- Asset CRUD ---

async def get_assets(
    db: AsyncSession,
    user_id: int,
    folder_id: Optional[int] = None,
    asset_type: Optional[str] = None,
    search: Optional[str] = None,
    space_key: Optional[str] = None,
    skip: int = 0,
    limit: int = 200,
) -> Sequence[AssetItem]:
    q = select(AssetItem).where(AssetItem.user_id == user_id)

    if space_key:
        q = q.where(AssetItem.space_key == space_key)

    if folder_id is not None:
        q = q.where(AssetItem.folder_id == folder_id)

    if asset_type and asset_type != "all":
        q = q.where(AssetItem.type == asset_type)

    if search:
        like = f"%{search}%"
        q = q.where(AssetItem.name.ilike(like))

    q = q.order_by(AssetItem.updated_at.desc()).offset(skip).limit(limit)
    result = await db.execute(q)
    return result.scalars().all()


async def get_asset(db: AsyncSession, asset_id: int, user_id: int) -> Optional[AssetItem]:
    result = await db.execute(
        select(AssetItem).where(AssetItem.id == asset_id, AssetItem.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def create_asset(db: AsyncSession, user_id: int, **kwargs) -> AssetItem:
    asset = AssetItem(user_id=user_id, **kwargs)
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    return asset


async def create_assets_batch(db: AsyncSession, user_id: int, items: list[dict]) -> list[AssetItem]:
    assets = [AssetItem(user_id=user_id, **item) for item in items]
    db.add_all(assets)
    await db.commit()
    for a in assets:
        await db.refresh(a)
    return assets


async def update_assets_batch(db: AsyncSession, ids: list[int], user_id: int, updates: dict) -> int:
    """Batch update multiple assets (scoped to user). Returns number of updated rows."""
    import datetime as _dt
    allowed = {"name", "type", "folder_id", "description"}
    filtered = {k: v for k, v in updates.items() if k in allowed and v is not None}
    if not filtered:
        return 0
    filtered["updated_at"] = _dt.datetime.now(_dt.timezone.utc)
    q = update(AssetItem).where(AssetItem.id.in_(ids), AssetItem.user_id == user_id).values(**filtered)
    result = await db.execute(q)
    await db.commit()
    return result.rowcount


async def update_asset(db: AsyncSession, asset_id: int, user_id: int, **kwargs) -> Optional[AssetItem]:
    import datetime as _dt
    asset = await get_asset(db, asset_id, user_id)
    if not asset:
        return None
    for key, value in kwargs.items():
        if value is not None:
            setattr(asset, key, value)
    asset.updated_at = _dt.datetime.now(_dt.timezone.utc)
    await db.commit()
    await db.refresh(asset)
    return asset


async def delete_asset(db: AsyncSession, asset_id: int, user_id: int) -> bool:
    import os as _os
    asset = await get_asset(db, asset_id, user_id)
    if not asset:
        return False

    # Collect file URLs to delete
    source_url = (asset.extra_data or {}).get("sourceUrl")
    urls = [source_url] if source_url else []

    UPLOAD_DIR = _os.path.join(_os.path.dirname(__file__), "..", "..", "uploads")
    for url in urls:
        if not url or "/api/files/" not in url:
            continue
        rel = url.split("/api/files/")[-1]
        filepath = _os.path.join(UPLOAD_DIR, rel)
        try:
            if _os.path.isfile(filepath):
                _os.remove(filepath)
        except OSError:
            pass

    await db.delete(asset)
    await db.commit()
    return True

from typing import Optional, Sequence

from sqlalchemy import select, delete, update
from sqlalchemy import text as _sql
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import AssetItem, AssetFolder


def _parse_hash_from_url(url: str) -> str | None:
    """从 URL 提取 64 字符 SHA256 hash。URL 格式: /api/files/{user_id}/{hash[:2]}/{hash}{ext}"""
    if not url or "/api/files/" not in url:
        return None
    path = url.split("/api/files/")[-1]
    parts = path.split("/")
    if len(parts) != 3:
        return None
    fn = parts[2]
    dot = fn.rfind(".")
    h = fn[:dot] if dot > 0 else fn
    return h if len(h) == 64 else None


# --- Folder CRUD ---

async def get_folders(db: AsyncSession, user_id: int, space_key: str) -> list[dict]:
    from sqlalchemy import func, literal_column
    count_subq = (
        select(func.count(AssetItem.id))
        .where(AssetItem.folder_id == AssetFolder.id, AssetItem.user_id == user_id)
        .correlate(AssetFolder)
        .scalar_subquery()
    )
    q = (
        select(AssetFolder, count_subq.label("count"))
        .where(AssetFolder.user_id == user_id, AssetFolder.space_key == space_key)
        .order_by(AssetFolder.name)
    )
    result = await db.execute(q)
    return [{"id": f.id, "user_id": f.user_id, "name": f.name, "space_key": f.space_key,
             "parent_id": f.parent_id, "created_at": f.created_at, "count": c}
            for f, c in result.all()]


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


async def _collect_subtree_folder_ids(db: AsyncSession, user_id: int, root_id: int) -> list[int]:
    """Collect the full subtree of folder ids rooted at ``root_id`` (inclusive)."""
    result = await db.execute(select(AssetFolder).where(AssetFolder.user_id == user_id))
    folders = result.scalars().all()
    children_map: dict[int | None, list[int]] = {}
    for f in folders:
        children_map.setdefault(f.parent_id, []).append(f.id)
    ids: list[int] = []
    queue = [root_id]
    while queue:
        cur = queue.pop()
        ids.append(cur)
        for child in children_map.get(cur, []):
            queue.append(child)
    return ids


async def delete_folder(db: AsyncSession, folder_id: int, user_id: int) -> bool:
    folder = await get_folder(db, folder_id, user_id)
    if not folder:
        return False

    # Collect the whole subtree (folder + all descendant subfolders).
    subtree_ids = await _collect_subtree_folder_ids(db, user_id, folder_id)

    # Fully delete every asset inside the subtree, cleaning up file references.
    assets = (
        await db.execute(
            select(AssetItem).where(
                AssetItem.user_id == user_id,
                AssetItem.folder_id.in_(subtree_ids),
            )
        )
    ).scalars().all()
    for asset in assets:
        source_url = (asset.extra_data or {}).get("sourceUrl")
        await _remove_asset_ref(db, user_id, source_url, asset.id)
    if assets:
        await db.execute(
            delete(AssetItem).where(
                AssetItem.user_id == user_id,
                AssetItem.folder_id.in_(subtree_ids),
            )
        )

    # Delete the folders explicitly (child folders are removed recursively).
    await db.execute(
        delete(AssetFolder).where(
            AssetFolder.user_id == user_id,
            AssetFolder.id.in_(subtree_ids),
        )
    )
    await db.commit()
    return True


# --- Asset CRUD ---


def _build_asset_filter_query(user_id: int, folder_id: Optional[int] = None, asset_type: Optional[str] = None, search: Optional[str] = None, space_key: Optional[str] = None):
    q = select(AssetItem).where(AssetItem.user_id == user_id)
    if space_key:
        q = q.where(AssetItem.space_key == space_key)
    if folder_id == -1:
        q = q.where(AssetItem.folder_id.is_(None))
    elif folder_id is not None:
        q = q.where(AssetItem.folder_id == folder_id)
    if asset_type and asset_type != "all":
        q = q.where(AssetItem.type == asset_type)
    if search:
        like = f"%{search}%"
        q = q.where(AssetItem.name.ilike(like))
    return q


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
    q = _build_asset_filter_query(user_id, folder_id, asset_type, search, space_key)
    q = q.order_by(AssetItem.updated_at.desc()).offset(skip).limit(limit)
    result = await db.execute(q)
    return result.scalars().all()


async def count_assets(
    db: AsyncSession,
    user_id: int,
    folder_id: Optional[int] = None,
    asset_type: Optional[str] = None,
    search: Optional[str] = None,
    space_key: Optional[str] = None,
) -> int:
    from sqlalchemy import func
    q = _build_asset_filter_query(user_id, folder_id, asset_type, search, space_key)
    q = q.with_only_columns(func.count()).order_by(None)
    result = await db.execute(q)
    return result.scalar_one()


async def get_asset(db: AsyncSession, asset_id: int, user_id: int) -> Optional[AssetItem]:
    result = await db.execute(
        select(AssetItem).where(AssetItem.id == asset_id, AssetItem.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def _add_asset_ref(db: AsyncSession, user_id: int, source_url: str | None, asset_id: int):
    """记录 asset 对文件的引用（同一事务中调用，不自己 commit）"""
    if not source_url:
        return
    file_hash = _parse_hash_from_url(source_url)
    if not file_hash:
        return
    await db.execute(
        _sql("INSERT OR IGNORE INTO file_references (file_hash, user_id, ref_type, ref_id) "
             "VALUES (:h, :uid, 'asset', :rid)"),
        {"h": file_hash, "uid": user_id, "rid": asset_id},
    )


async def _remove_asset_ref(db: AsyncSession, user_id: int, source_url: str | None, asset_id: int):
    """删除 asset 对文件的引用（同一事务中调用，不自己 commit）"""
    if not source_url:
        return
    file_hash = _parse_hash_from_url(source_url)
    if not file_hash:
        return
    await db.execute(
        _sql("DELETE FROM file_references WHERE file_hash = :h AND user_id = :uid AND ref_type = 'asset' AND ref_id = :rid"),
        {"h": file_hash, "uid": user_id, "rid": asset_id},
    )


async def create_asset(db: AsyncSession, user_id: int, **kwargs) -> AssetItem:
    asset = AssetItem(user_id=user_id, **kwargs)
    db.add(asset)
    # flush 让 asset.id 生成
    await db.flush()
    # 与 asset 记录创建在同一事务中
    await _add_asset_ref(db, user_id, (kwargs.get("extra_data") or {}).get("sourceUrl"), asset.id)
    await db.commit()
    await db.refresh(asset)
    return asset


async def create_assets_batch(db: AsyncSession, user_id: int, items: list[dict]) -> list[AssetItem]:
    assets = [AssetItem(user_id=user_id, **item) for item in items]
    db.add_all(assets)
    await db.flush()
    # 与 asset 记录创建在同一事务中（需要 asset.id，所以先 flush）
    for asset, item in zip(assets, items):
        await _add_asset_ref(db, user_id, (item.get("extra_data") or {}).get("sourceUrl"), asset.id)
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
    asset = await get_asset(db, asset_id, user_id)
    if not asset:
        return False

    source_url = (asset.extra_data or {}).get("sourceUrl")
    # 与 asset 记录删除在同一事务中
    await _remove_asset_ref(db, user_id, source_url, asset_id)
    await db.delete(asset)
    await db.commit()
    return True

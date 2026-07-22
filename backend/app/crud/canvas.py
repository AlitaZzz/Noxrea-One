from typing import Optional, Sequence

from sqlalchemy import select, delete
from sqlalchemy import text as _sql
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.canvas import CanvasProject


def _parse_hash_from_url(url: str) -> str | None:
    """与 crud/asset.py 相同的解析逻辑。返回 hash 或 None。"""
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


def _collect_canvas_hashes(canvas_data: dict) -> set[str]:
    """从 canvas_data 中收集所有文件引用 hash（去重）"""
    hashes: set[str] = set()
    for node in canvas_data.get("nodes", []):
        d = node.get("data") or {}
        # image-node / video-node: data.src
        src = d.get("src")
        if isinstance(src, str):
            h = _parse_hash_from_url(src)
            if h:
                hashes.add(h)
        # image-group-node: data.images[].url
        for img in (d.get("images") or []):
            url = img.get("url") if isinstance(img, dict) else None
            if isinstance(url, str):
                h = _parse_hash_from_url(url)
                if h:
                    hashes.add(h)
    return hashes


async def _recalc_project_refs(db: AsyncSession, project_id: int, user_id: int, canvas_data: dict):
    """对比新旧 hash 集合，增删 file_references 中 ref_type='canvas_project' 的记录。"""
    rows = await db.execute(
        _sql("SELECT file_hash FROM file_references WHERE ref_type = 'canvas_project' AND ref_id = :rid"),
        {"rid": project_id},
    )
    old_set = {r[0] for r in rows.fetchall()}
    new_set = _collect_canvas_hashes(canvas_data)

    for h in new_set - old_set:
        await db.execute(
            _sql("INSERT OR IGNORE INTO file_references (file_hash, user_id, ref_type, ref_id) "
                 "VALUES (:h, :uid, 'canvas_project', :rid)"),
            {"h": h, "uid": user_id, "rid": project_id},
        )
    for h in old_set - new_set:
        await db.execute(
            _sql("DELETE FROM file_references WHERE file_hash = :h AND ref_type = 'canvas_project' AND ref_id = :rid"),
            {"h": h, "rid": project_id},
        )


async def get_projects(db: AsyncSession, user_id: int) -> Sequence[CanvasProject]:
    q = select(CanvasProject).where(CanvasProject.user_id == user_id)
    q = q.order_by(CanvasProject.updated_at.desc())
    result = await db.execute(q)
    return result.scalars().all()


async def get_project(db: AsyncSession, project_id: int) -> Optional[CanvasProject]:
    result = await db.execute(select(CanvasProject).where(CanvasProject.id == project_id))
    return result.scalar_one_or_none()


async def create_project(
    db: AsyncSession, user_id: int, name: str, canvas_data: dict
) -> CanvasProject:
    project = CanvasProject(user_id=user_id, name=name, canvas_data=canvas_data)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


async def update_project(
    db: AsyncSession, project_id: int, user_id: int,
    name: Optional[str], canvas_data: Optional[dict],
    needRefRecalc: bool = False,
) -> Optional[CanvasProject]:
    project = await get_project(db, project_id)
    if not project:
        return None
    if name is not None:
        project.name = name
    if canvas_data is not None:
        project.canvas_data = canvas_data
        if needRefRecalc:
            await _recalc_project_refs(db, project_id, user_id, canvas_data)
    await db.commit()
    await db.refresh(project)
    return project


async def delete_project(db: AsyncSession, project_id: int) -> bool:
    project = await get_project(db, project_id)
    if not project:
        return False
    # 清理该项目的所有文件引用记录
    await db.execute(
        _sql("DELETE FROM file_references WHERE ref_type = 'canvas_project' AND ref_id = :rid"),
        {"rid": project_id},
    )
    await db.delete(project)
    await db.commit()
    return True

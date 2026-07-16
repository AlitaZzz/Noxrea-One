from typing import Optional, Sequence

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.canvas import CanvasProject


async def get_projects(db: AsyncSession, user_id: Optional[int]) -> Sequence[CanvasProject]:
    q = select(CanvasProject)
    if user_id is not None:
        q = q.where(CanvasProject.user_id == user_id)
    q = q.order_by(CanvasProject.updated_at.desc())
    result = await db.execute(q)
    return result.scalars().all()


async def get_project(db: AsyncSession, project_id: int) -> Optional[CanvasProject]:
    result = await db.execute(
        select(CanvasProject).where(CanvasProject.id == project_id)
    )
    return result.scalar_one_or_none()


async def create_project(
    db: AsyncSession, user_id: Optional[int], name: str, canvas_data: dict
) -> CanvasProject:
    project = CanvasProject(user_id=user_id, name=name, canvas_data=canvas_data)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


async def update_project(
    db: AsyncSession, project_id: int, name: Optional[str], canvas_data: Optional[dict]
) -> Optional[CanvasProject]:
    project = await get_project(db, project_id)
    if not project:
        return None
    if name is not None:
        project.name = name
    if canvas_data is not None:
        project.canvas_data = canvas_data
    await db.commit()
    await db.refresh(project)
    return project


async def delete_project(db: AsyncSession, project_id: int) -> bool:
    project = await get_project(db, project_id)
    if not project:
        return False
    await db.delete(project)
    await db.commit()
    return True

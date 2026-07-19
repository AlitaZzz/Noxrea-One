import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.common import UnifiedResponse
from app.schemas.canvas import (
    CanvasProjectCreate,
    CanvasProjectUpdate,
    CanvasProjectOut,
    CanvasProjectListItem,
)
from app.deps import get_db, get_current_user
from app.crud import canvas as crud
from app.models.canvas import CanvasProject

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/canvas", tags=["canvas"])


async def get_owned_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
) -> CanvasProject:
    """获取项目并验证所有权。用于 get/update/delete 三个端点注入。"""
    project = await crud.get_project(db, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if project.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return project


@router.get("/projects", response_model=UnifiedResponse[list[CanvasProjectListItem]])
async def list_projects(
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    projects = await crud.get_projects(db, user.id)
    return UnifiedResponse(
        code=200,
        data=[CanvasProjectListItem.model_validate(p) for p in projects],
        msg="ok",
    )


@router.post("/projects", response_model=UnifiedResponse[CanvasProjectOut])
async def create_project(
    body: CanvasProjectCreate,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    project = await crud.create_project(db, user.id, body.name, body.canvas_data)
    return UnifiedResponse(code=200, data=CanvasProjectOut.model_validate(project), msg="created")


@router.get("/projects/{project_id}", response_model=UnifiedResponse[CanvasProjectOut])
async def get_project(
    project: CanvasProject = Depends(get_owned_project),
):
    return UnifiedResponse(code=200, data=CanvasProjectOut.model_validate(project), msg="ok")


@router.put("/projects/{project_id}", response_model=UnifiedResponse[CanvasProjectOut])
async def update_project(
    project_id: int,
    body: CanvasProjectUpdate,
    db: AsyncSession = Depends(get_db),
    owned_project: CanvasProject = Depends(get_owned_project),
):
    updated = await crud.update_project(db, project_id, owned_project.user_id, body.name, body.canvas_data, body.needRefRecalc)
    logger.debug(f"Project saved: id={project_id} user={owned_project.user_id} nodes={len(body.canvas_data.get('nodes',[]) if body.canvas_data else [])}")
    return UnifiedResponse(code=200, data=CanvasProjectOut.model_validate(updated), msg="updated")


@router.delete("/projects/{project_id}", response_model=UnifiedResponse)
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _owned_project: CanvasProject = Depends(get_owned_project),
):
    ok = await crud.delete_project(db, project_id)
    return UnifiedResponse(code=200, msg="deleted")

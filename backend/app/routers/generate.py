import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_db, get_current_user
from app.schemas.common import UnifiedResponse
from app.schemas.task import TaskOut
from app.crud import task as crud

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/generate", tags=["generate"])


# ── Submit image generation task ────────────────────────────────


@router.post("/task", response_model=UnifiedResponse[TaskOut])
async def create_task(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    task_type = body.get("type", "image")

    # bg_removal tasks use the inference service directly (no AI provider config needed)
    if task_type == "bg_removal":
        prompt = ""
        config = {}
    else:
        prompt = (body.get("prompt") or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="Missing prompt")

        config = {
            "model": body.get("model", ""),
            "baseUrl": body.get("baseUrl", ""),
            "apiKey": body.get("apiKey", ""),
            "quality": body.get("quality", "auto"),
            "size": body.get("size", "1K"),
            "ratio": body.get("ratio", "1:1"),
            "n": body.get("n", 1),
        }
        # Validate
        if not config["baseUrl"] or not config["apiKey"]:
            raise HTTPException(status_code=400, detail="Missing baseUrl or apiKey")

    task_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc)
    ref_urls = body.get("refUrls") or body.get("ref_urls") or []
    node_id = body.get("nodeId") or body.get("node_id") or ""

    task = await crud.create_task(
        db, task_id, user.id, task_type, prompt, config, ref_urls, node_id, now,
    )
    logger.info(f"Task created: id={task_id} type={task_type} user={user.id} node={node_id} prompt_len={len(prompt)}")

    return UnifiedResponse(
        code=200,
        data=TaskOut.model_validate(task),
        msg="task created",
    )


# ── Get task status ─────────────────────────────────────────────


@router.get("/task/{task_id}", response_model=UnifiedResponse[TaskOut])
async def get_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    task = await crud.get_task(db, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.user_id != user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    return UnifiedResponse(code=200, data=TaskOut.model_validate(task), msg="ok")


# ── SSE stream ──────────────────────────────────────────────────


@router.get("/task/{task_id}/stream")
async def stream_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    # Verify task exists and belongs to user
    task = await crud.get_task(db, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.user_id != user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    async def event_stream():
        logger.debug(f"SSE stream opened: task_id={task_id} user={user.id}")
        last_status = ""
        while True:
            # Use fresh session per poll + filter by user_id (secondary guard)
            from app.database import async_session as _sse_session
            async with _sse_session() as sse_db:
                task = await crud.get_task_for_user(sse_db, task_id, user.id)
            if not task:
                yield f"data: {json.dumps({'type': 'error', 'error': 'Task deleted'})}\n\n"
                break

            status = task.status
            if status != last_status:
                event = {
                    "type": "status",
                    "task_id": task_id,
                    "status": status,
                    "result_url": task.result_url,
                    "error": task.error,
                    "config": task.config,
                    "prompt": task.prompt,
                }
                yield f"data: {json.dumps(event)}\n\n"
                last_status = status

                if status in ("completed", "failed"):
                    logger.info(f"SSE stream ended: task_id={task_id} status={status}")
                    break

            await asyncio.sleep(3)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


# ── Cancel task ──────────────────────────────────────────────────


@router.post("/task/{task_id}/cancel", response_model=UnifiedResponse)
async def cancel_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    row = await crud.get_task_status(db, task_id)
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    db_user_id, status = row
    if db_user_id != user.id:
        raise HTTPException(status_code=403, detail="Access denied")
    if status in ("completed", "failed"):
        raise HTTPException(status_code=400, detail="Task already finished")

    await crud.cancel_task(db, task_id, datetime.now(timezone.utc))
    logger.info(f"Task cancelled: id={task_id} user={user.id}")
    return UnifiedResponse(code=200, msg="cancelled")



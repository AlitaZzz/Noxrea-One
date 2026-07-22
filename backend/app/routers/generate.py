import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_db, get_current_user
from app.schemas.common import UnifiedResponse
from app.schemas.task import TaskOut
from app.crud import task as crud
from app.crud import model_config as crud_model_config
from app.database import async_session as _sse_session

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

        channel_id = body.get("channelId")
        try:
            channel_id_int = int(channel_id) if channel_id else 0
        except (TypeError, ValueError):
            channel_id_int = 0
        if not channel_id_int:
            raise HTTPException(status_code=400, detail="Missing or invalid channelId")
        # 校验 channel 归属当前用户；apiKey/baseUrl 不再存进 task，处理时按 channel_id 解析
        channel = await crud_model_config.get_channel(db, channel_id_int, user.id)
        if not channel:
            raise HTTPException(status_code=400, detail="Channel not found")

        config = {
            "channel_id": channel_id_int,
            "model": body.get("model", ""),
            "quality": body.get("quality", "auto"),
            "size": body.get("size", "1K"),
            "ratio": body.get("ratio", "1:1"),
            # n 限幅到 [1,4]，防止前端传超大值放大计费/触发限流
            "n": max(1, min(4, int(body.get("n", 1) or 1))),
        }

    task_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc)
    ref_urls = body.get("refUrls") or body.get("ref_urls") or []
    node_id = body.get("nodeId") or body.get("node_id") or ""

    task = await crud.create_task(
        db, task_id, user.id, task_type, prompt, config, ref_urls, node_id, now,
    )
    logger.info(f"task created id={task_id} type={task_type} user={user.id} node={node_id} prompt_len={len(prompt)}")

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
    request: Request,
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
        logger.debug(f"SSE stream opened task_id={task_id} user={user.id}")
        last_status = ""
        while True:
            # 客户端断连则退出，避免连接/内存堆积
            if await request.is_disconnected():
                logger.debug(f"SSE client disconnected task_id={task_id}")
                break
            # Use fresh session per poll + filter by user_id (secondary guard)
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
                    logger.debug(f"SSE stream ended task_id={task_id} status={status}")
                    break

            # 1s 轮询：让 completed/failed 更快推给前端（DB 查询频率略升可接受）
            await asyncio.sleep(1)

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
    logger.info(f"task cancelled id={task_id} user={user.id}")
    return UnifiedResponse(code=200, msg="cancelled")



import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_db, get_current_user
from app.logging_config import log_event
from app.schemas.common import UnifiedResponse
from app.schemas.task import TaskOut
from app.crud import task as crud
from app.crud import model_config as crud_model_config
from app.database import async_session as _sse_session
from app.services.events.bus import event_bus
from app.services.events.types import EventType, TaskEvent

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/generate", tags=["generate"])


# ── Submit generation task ───────────────────────────────────────


@router.post("/task", response_model=UnifiedResponse[TaskOut])
async def create_task(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    # 向后兼容：capability 优先，回退到 type
    task_type = body.get("capability") or body.get("type", "image")
    logger.debug(
        f"[generate] request received task_type={task_type} "
        f"channel_id={body.get('channelId')} model={body.get('model', '')}"
    )

    # bg_removal: internal capability, no external channel needed
    if task_type == "bg_removal":
        prompt = ""
        config = {}
        protocol_name = ""
        model_name = ""
    else:
        prompt = (body.get("prompt") or "").strip()
        if not prompt and task_type not in ("llm", "audio"):
            raise HTTPException(status_code=400, detail="Missing prompt")

        channel_id = body.get("channelId")
        try:
            channel_id_int = int(channel_id) if channel_id else 0
        except (TypeError, ValueError):
            channel_id_int = 0
        if not channel_id_int:
            raise HTTPException(status_code=400, detail="Missing or invalid channelId")
        channel = await crud_model_config.get_channel(db, channel_id_int, user.id)
        if not channel:
            raise HTTPException(status_code=400, detail="Channel not found")

        model_name = body.get("model", "")
        # 协议直接读取 channel 配置（用户创建渠道时手动选择），不做自动猜测
        protocol_name = channel.protocol or "openai"
        if not protocol_name:
            raise HTTPException(status_code=400, detail="Channel 未配置 protocol")

        config = {
            "channel_id": channel_id_int,
            "model": model_name,
            "quality": body.get("quality"),
            "resolution": body.get("resolution"),
            "ratio": body.get("ratio"),
            "n": max(1, min(4, int(body.get("n", 1) or 1))),
            "protocol": protocol_name,
            "capability": task_type,
        }
        # 仅当前端明确传入时才写入（避免图片任务 config 里出现 voice/stream 等无关字段）
        for k in ("stream", "voice", "messages"):
            if body.get(k) is not None:
                config[k] = body[k]

    task_id = uuid.uuid4().hex[:8]
    now = datetime.now(timezone.utc)
    ref_images = body.get("ref_images") or []
    node_id = body.get("nodeId") or body.get("node_id") or ""

    task = await crud.create_task(
        db, task_id, user.id, task_type, prompt, config, ref_images, node_id, now,
        capability=task_type, protocol=protocol_name, model=model_name,
    )
    logger.info(log_event("generate", task_id=task_id, stage="created",
                          type=task_type, model=model_name, prompt_len=len(prompt)))

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
    task = await crud.get_task(db, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.user_id != user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    async def event_stream():
        logger.debug(f"SSE stream opened task_id={task_id} user={user.id}")

        # 1. 预创建订阅者队列，防止 emit 在 subscribe 之前丢失事件
        queue = await event_bus.ensure_queue(task_id)

        # 2. 查 DB：任务可能已完成（竞态保护）
        async with _sse_session() as sse_db:
            current = await crud.get_task_for_user(sse_db, task_id, user.id)
        if not current:
            yield f"data: {json.dumps({'type': 'error', 'error': 'Task deleted'})}\n\n"
            await event_bus.unsubscribe(task_id, queue)
            return

        if current.status in ("completed", "failed"):
            # 任务已结束，直接推送结果
            event = {
                "type": "status",
                "task_id": task_id,
                "status": current.status,
                "result_urls": current.result_urls or [],
                "result_text": current.result_text,
                "error": current.error,
                "config": current.config,
                "prompt": current.prompt,
            }
            yield f"data: {json.dumps(event)}\n\n"
            await event_bus.unsubscribe(task_id, queue)
            return

        # 3. 推送当前 processing/pending 状态
        yield f"data: {json.dumps({'type': 'status', 'task_id': task_id, 'status': current.status})}\n\n"

        # 4. 订阅 EventBus，带超时轮询检测客户端断开
        try:
            while True:
                if await request.is_disconnected():
                    logger.debug(f"SSE client disconnected task_id={task_id}")
                    break

                evt = await event_bus.wait_event(queue, timeout=5.0)
                if evt is None:
                    # 超时，无事件，继续循环检查断开
                    continue

                # 构造 SSE 事件
                event = {
                    "type": "status",
                    "task_id": task_id,
                    "status": "completed" if evt.event_type == EventType.TASK_COMPLETED else "failed",
                    "result_urls": evt.data.get("result_urls", []),
                    "result_text": evt.data.get("result_text"),
                    "error": evt.data.get("error"),
                    "config": current.config,
                    "prompt": current.prompt,
                }
                yield f"data: {json.dumps(event)}\n\n"

                if evt.event_type in (EventType.TASK_COMPLETED, EventType.TASK_FAILED):
                    logger.debug(f"SSE stream ended task_id={task_id} status={event['status']}")
                    break
        finally:
            await event_bus.unsubscribe(task_id, queue)
            logger.debug(f"SSE stream closed task_id={task_id}")

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
    # 发布取消事件，通知 SSE 客户端
    await event_bus.publish(TaskEvent(
        event_type=EventType.TASK_FAILED,
        task_id=task_id,
        user_id=user.id,
        capability="",
        data={"status": "failed", "error": "Cancelled"},
    ))
    logger.info(log_event("generate", task_id=task_id, stage="cancelled"))
    return UnifiedResponse(code=200, msg="cancelled")

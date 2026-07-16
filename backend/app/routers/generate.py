import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_db, get_current_user
from app.schemas.common import UnifiedResponse
from app.schemas.task import TaskOut

router = APIRouter(prefix="/api/generate", tags=["generate"])


# ── Submit image generation task ────────────────────────────────


@router.post("/task", response_model=UnifiedResponse[TaskOut])
async def create_task(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
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

    await db.execute(
        text("""
            INSERT INTO generation_tasks
                (id, user_id, type, status, prompt, config, ref_urls, node_id, created_at, updated_at)
            VALUES
                (:id, :uid, :type, 'pending', :prompt, :config, :refs, :nid, :now, :now)
        """),
        {
            "id": task_id,
            "uid": user.id,
            "type": body.get("type", "image"),
            "prompt": prompt,
            "config": json.dumps(config),
            "refs": json.dumps(ref_urls) if ref_urls else "[]",
            "nid": node_id,
            "now": now,
        },
    )
    await db.commit()

    return UnifiedResponse(
        code=200,
        data=TaskOut(
            id=task_id,
            user_id=user.id,
            type=body.get("type", "image"),
            status="pending",
            prompt=prompt,
            config=config,
            ref_urls=ref_urls or None,
            node_id=node_id,
            created_at=now,
            updated_at=now,
        ),
        msg="task created",
    )


# ── Get task status ─────────────────────────────────────────────


@router.get("/task/{task_id}", response_model=UnifiedResponse[TaskOut])
async def get_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    result = await db.execute(
        text("SELECT id, user_id, type, status, prompt, config, ref_urls, "
             "result_url, error, node_id, created_at, updated_at "
             "FROM generation_tasks WHERE id = :id"),
        {"id": task_id},
    )
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    if row[1] != user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    return UnifiedResponse(code=200, data=_row_to_out(row), msg="ok")


# ── SSE stream ──────────────────────────────────────────────────


@router.get("/task/{task_id}/stream")
async def stream_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    # Verify task exists and belongs to user
    result = await db.execute(
        text("SELECT id, user_id, type, status, prompt, config, ref_urls, "
             "result_url, error, node_id, created_at, updated_at "
             "FROM generation_tasks WHERE id = :id"),
        {"id": task_id},
    )
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    if row[1] != user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    async def event_stream():
        last_status = ""
        while True:
            # Use fresh session per poll to avoid stale data
            from app.database import async_session as _sse_session
            async with _sse_session() as sse_db:
                result = await sse_db.execute(
                    text("SELECT id, user_id, type, status, prompt, config, ref_urls, "
                         "result_url, error, node_id, created_at, updated_at "
                         "FROM generation_tasks WHERE id = :id"),
                    {"id": task_id},
                )
                row = result.fetchone()
            if not row:
                yield f"data: {json.dumps({'type': 'error', 'error': 'Task deleted'})}\n\n"
                break

            status = row[3]
            if status != last_status:
                out = _row_to_out(row)
                event = {
                    "type": "status",
                    "task_id": task_id,
                    "status": status,
                    "result_url": out.result_url,
                    "error": out.error,
                    "config": out.config,
                    "prompt": out.prompt,
                }
                yield f"data: {json.dumps(event)}\n\n"
                last_status = status

                if status in ("completed", "failed"):
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
    result = await db.execute(
        text("SELECT user_id, status FROM generation_tasks WHERE id = :id"),
        {"id": task_id},
    )
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    if row[0] != user.id:
        raise HTTPException(status_code=403, detail="Access denied")
    if row[1] in ("completed", "failed"):
        raise HTTPException(status_code=400, detail="Task already finished")

    await db.execute(
        text("UPDATE generation_tasks SET status = 'failed', error = 'Cancelled', updated_at = :now WHERE id = :id"),
        {"now": datetime.now(timezone.utc), "id": task_id},
    )
    await db.commit()
    return UnifiedResponse(code=200, msg="cancelled")


# ── Helper ──────────────────────────────────────────────────────


def _row_to_out(row) -> TaskOut:
    config = row[5]
    if isinstance(config, str):
        config = json.loads(config)
    refs = row[6]
    if isinstance(refs, str):
        refs = json.loads(refs) if refs else None

    return TaskOut(
        id=row[0], user_id=row[1], type=row[2], status=row[3],
        prompt=row[4], config=config, ref_urls=refs,
        result_url=row[7], error=row[8], node_id=row[9],
        created_at=row[10], updated_at=row[11],
    )


# ── Import needed for SSE streaming ─────────────────────────────
import asyncio

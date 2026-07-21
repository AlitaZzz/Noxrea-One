"""
Background worker that processes generation tasks from the queue.
"""

import asyncio
import base64
import logging
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)
from app.models.task import GenerationTask
from app.services.providers import build_endpoint, detect_provider, download_and_save, is_async_provider

# ── Constants ───────────────────────────────────────────────────

POLL_INTERVAL_SEC = settings.WORKER_POLL_INTERVAL
MAX_CONCURRENCY = settings.WORKER_MAX_CONCURRENCY
STUCK_TIMEOUT_MIN = settings.WORKER_STUCK_TIMEOUT
API_TIMEOUT_SEC = settings.WORKER_API_TIMEOUT
ZOMBIE_CHECK_INTERVAL = settings.WORKER_ZOMBIE_INTERVAL

# ── Engine & session (worker owns its own to avoid lifespan coupling) ──

_engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    connect_args={"timeout": settings.DB_TIMEOUT} if "sqlite" in settings.DATABASE_URL else {},
)

_async_session = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)


async def _ensure_wal():
    """Enable WAL mode for SQLite to reduce lock contention."""
    if "sqlite" not in settings.DATABASE_URL:
        return
    async with _engine.connect() as conn:
        await conn.execute(text("PRAGMA journal_mode=WAL"))


# ── Atomic task claim ──────────────────────────────────────────


async def _claim_tasks(db: AsyncSession, limit: int = 10) -> list[GenerationTask]:
    """原子地批量领取最多 limit 条 pending 任务。

    单条 UPDATE ... WHERE id IN (SELECT ... pending LIMIT N) RETURNING *：
    - WHERE status='pending' 保证并发下只领取仍为 pending 的行
    - RETURNING 只返回真正被改成 processing 的行，等价于旧逻辑的二次确认
    - 一次往返 + 一次 commit，替代旧的逐条 SELECT+UPDATE+re-SELECT
    """
    now = datetime.now(timezone.utc)
    result = await db.execute(
        text(
            "UPDATE generation_tasks SET status = 'processing', updated_at = :now "
            "WHERE id IN (SELECT id FROM generation_tasks WHERE status = 'pending' "
            "ORDER BY created_at ASC LIMIT :limit) "
            "RETURNING id, user_id, type, status, prompt, config, ref_urls, "
            "result_url, error, node_id, created_at, updated_at"
        ),
        {"now": now, "limit": limit},
    )
    rows = result.fetchall()
    await db.commit()
    return [
        GenerationTask(
            id=row[0], user_id=row[1], type=row[2], status=row[3],
            prompt=row[4], config=row[5], ref_urls=row[6],
            result_url=row[7], error=row[8], node_id=row[9],
            created_at=row[10], updated_at=row[11],
        )
        for row in rows
    ]


# ── Resolve reference images to base64 ────────────────────────


def _is_local_url(url: str) -> bool:
    """判断 url 是否指向本服务（需下载后转 base64，外部 provider 访问不到 localhost）。"""
    if any(x in url for x in ("localhost", "127.0.0.1")):
        return True
    pub = settings.PUBLIC_URL
    if pub:
        try:
            return urlparse(url).hostname == urlparse(pub).hostname
        except Exception:
            return False
    return False


async def _resolve_refs(ref_urls: list[str]) -> list[str]:
    """Convert local file URLs to base64 data URLs (AI providers can't access localhost)."""
    if not ref_urls:
        return []
    resolved: list[str] = []
    async with httpx.AsyncClient(timeout=30) as client:
        for url in ref_urls:
            # Local file → download and convert to base64
            if _is_local_url(url):
                try:
                    resp = await client.get(url)
                    if resp.is_success:
                        b64 = base64.b64encode(resp.content).decode()
                        mime = resp.headers.get("content-type", "image/png")
                        resolved.append(f"data:{mime};base64,{b64}")
                        continue
                except Exception:
                    pass
            # Already a data URL or external URL → pass through
            resolved.append(url)
    return resolved


# ── Process a single task ──────────────────────────────────────


async def _process_task(task: GenerationTask) -> None:
    """Process one task: call AI API, save result, update DB."""
    config = task.config or {}
    if isinstance(config, str):
        import json as _json
        config = _json.loads(config)
    model = config.get("model", "")
    quality = config.get("quality", "auto")
    ratio = config.get("ratio", "1:1")
    size = config.get("size", "1K")
    n = config.get("n", 1)
    raw_refs = task.ref_urls or []
    if isinstance(raw_refs, str):
        import json as _json
        raw_refs = _json.loads(raw_refs) if raw_refs else []
    refs = await _resolve_refs(raw_refs)

    # image/video 按 channel_id 解析 baseUrl/apiKey（apiKey 不再落库到 task）；
    # bg_removal 走推理服务，不需要 channel。
    if task.type == "bg_removal":
        base_url, api_key = "", ""
    else:
        channel_id = config.get("channel_id")
        try:
            channel_id_int = int(channel_id) if channel_id else 0
        except (TypeError, ValueError):
            channel_id_int = 0
        if not channel_id_int:
            await _update_task_status(task.id, "failed", error="Missing or invalid channel_id in task config")
            return
        from app.crud import model_config as crud_mc
        async with _async_session() as db:
            channel = await crud_mc.get_channel(db, channel_id_int, task.user_id)
        if not channel:
            await _update_task_status(task.id, "failed", error="Channel not found")
            return
        base_url, api_key = channel.base_url, channel.api_key

    provider = detect_provider(base_url)
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=API_TIMEOUT_SEC) as client:
        try:
            logger.info(f"processing task={task.id} type={task.type}")
            if task.type == "image":
                result_url = await _process_image(
                    client, provider, task, model, base_url, headers,
                    quality, ratio, size, n, refs,
                )
            elif task.type == "video":
                result_url = await _process_video(
                    client, provider, task, model, base_url, headers,
                    ratio, refs,
                )
            elif task.type == "bg_removal":
                result_url = await _process_bg_removal(task)
            else:
                await _update_task_status(task.id, "failed", error=f"Unknown type: {task.type}")
                return

            if result_url:
                # Download from CDN and save locally
                user_jwt = _make_user_jwt(task.user_id)
                local_url = await download_and_save(result_url, headers.get("Authorization", ""), user_jwt, task.type)
                await _update_task_status(task.id, "completed", result_url=local_url)
                logger.info(f"completed task={task.id}")
            else:
                await _update_task_status(task.id, "failed", error="No result from provider")
                logger.warning(f"no result task={task.id}")

        except asyncio.TimeoutError:
            logger.error(f"TIMEOUT task={task.id} type={task.type} url={base_url[:60]} model={model}"
                         f" timeout={API_TIMEOUT_SEC}s provider={type(provider).__name__}")
            await _update_task_status(task.id, "failed", error="API call timed out")
        except Exception as e:
            logger.error(f"error task={task.id} err={str(e)[:200]}")
            await _update_task_status(task.id, "failed", error=str(e)[:500])


async def _process_image(
    client, provider, task, model, base_url, headers,
    quality, ratio, size, n, refs,
) -> str | None:
    """Call image generation API and return CDN URL."""
    body = provider.build_image_body(model, task.prompt, n, ratio, size, quality, refs or None)
    suffix = (
        provider.image_edit_endpoint
        if (refs and provider.image_edit_endpoint)
        else provider.image_endpoint
    )
    endpoint = build_endpoint(base_url, suffix)

    logger.info(f"image request task={task.id} endpoint={endpoint} model={model} n={n}")
    t0 = time.perf_counter()
    try:
        data = await _post_with_retry(client, endpoint, body, headers, task.id)

        result_url, raw_bytes = provider.extract_image(data)
        if result_url:
            logger.info(f"image done task={task.id} took={int((time.perf_counter()-t0)*1000)}ms")
            return result_url

        # provider 返回 b64 -> 解码后通过文件接口上传
        if raw_bytes:
            local_url = await _upload_bytes(raw_bytes, task.user_id, "png")
            if local_url:
                logger.info(f"image done task={task.id} took={int((time.perf_counter()-t0)*1000)}ms (b64)")
                return local_url
            logger.error(f"image base64 upload failed task={task.id}")

        logger.warning(f"image no result task={task.id} data_keys={list(data.keys())}")
        return None
    except asyncio.TimeoutError:
        logger.error(f"image TIMEOUT task={task.id} endpoint={endpoint} model={model} timeout={API_TIMEOUT_SEC}s")
        raise
    except Exception as e:
        logger.error(f"image failed task={task.id} err={str(e)[:300]}")
        raise


async def _process_video(
    client, provider, task, model, base_url, headers,
    ratio, refs,
) -> str | None:
    """Call video creation API, poll for result, return CDN URL."""
    if not provider.video_endpoint or not is_async_provider(provider):
        return None

    # Create video task
    body = provider.build_video_body(model, task.prompt, ratio, refs or None)
    api_base = base_url.rstrip("/")
    endpoint = build_endpoint(api_base, provider.video_endpoint)
    data = await _post_with_retry(client, endpoint, body, headers, task.id)
    video_id = provider.extract_video_id(data)
    if not video_id:
        logger.error(f"no video_id in response task={task.id}")
        return None

    # Poll for completion
    poll_url = provider.build_poll_url(api_base, video_id)
    for _ in range(provider.max_poll_attempts):
        await asyncio.sleep(provider.poll_interval / 1000)
        poll_resp = await client.get(poll_url, headers=headers)
        if not poll_resp.is_success:
            continue
        poll_data = poll_resp.json()
        result = provider.extract_video_result(poll_data)
        if result == "__FAILED__":
            return None
        if result:
            return result

    return None


def _make_user_jwt(user_id: int) -> str:
    """Create JWT for the worker to authenticate with FastAPI endpoints."""
    from app.services.auth import create_access_token
    return create_access_token({"sub": str(user_id)})


async def _upload_bytes(raw: bytes, user_id: int, ext: str) -> str | None:
    """Upload raw bytes to local storage via the files API. Returns local URL or None."""
    user_jwt = _make_user_jwt(user_id)
    async with httpx.AsyncClient(timeout=60) as up_client:
        save_resp = await up_client.post(
            f"{settings.PUBLIC_URL}/api/files/upload?category=generated",
            files={"file": (f"generated.{ext}", raw)},
            headers={"Authorization": f"Bearer {user_jwt}"} if user_jwt else {},
        )
        if save_resp.is_success:
            return save_resp.json().get("data", {}).get("url")
    return None


# 瞬时错误重试：429/5xx/连接错误退避重试 1 次；4xx 业务错误、超时不重试
_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
MAX_RETRIES = 1


async def _post_with_retry(client: httpx.AsyncClient, endpoint: str, body: dict, headers: dict, task_id: str) -> dict:
    """POST 并对瞬时错误退避重试。返回解析后的 JSON。失败抛异常（交由调用方捕获）。"""
    last_exc: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = await asyncio.wait_for(client.post(endpoint, json=body, headers=headers), timeout=API_TIMEOUT_SEC)
            if resp.status_code in _RETRYABLE_STATUS and attempt < MAX_RETRIES:
                logger.warning(f"retryable status {resp.status_code} task={task_id} attempt={attempt+1}")
                await asyncio.sleep(1.5 * (attempt + 1))
                logger.info(f"retrying post task={task_id} attempt={attempt+1} endpoint={endpoint}")
                continue
            resp.raise_for_status()
            return resp.json()
        except (httpx.TransportError, httpx.RemoteProtocolError) as e:
            # 连接级错误：可重试
            last_exc = e
            if attempt < MAX_RETRIES:
                logger.warning(f"retryable transport error task={task_id} attempt={attempt+1} err={str(e)[:120]}")
                await asyncio.sleep(1.5 * (attempt + 1))
                logger.info(f"retrying post task={task_id} attempt={attempt+1} endpoint={endpoint}")
                continue
            raise
        except asyncio.TimeoutError:
            # 超时不重试（多为生成慢，重试只会更慢并双倍计费）
            raise
    # 重试用尽
    if last_exc:
        raise last_exc
    raise RuntimeError(f"post failed after retries: task={task_id} endpoint={endpoint}")


async def _process_bg_removal(task: GenerationTask) -> str | None:
    """Process a bg_removal task: call inference service, save result."""
    from app.config import settings as app_settings

    ref_urls = task.ref_urls or []
    if isinstance(ref_urls, str):
        import json as _json
        ref_urls = _json.loads(ref_urls) if ref_urls else []
    if not ref_urls:
        await _update_task_status(task.id, "failed", error="No source image URL provided")
        return None

    source_url = ref_urls[0]

    try:
        # 1. Download source image
        async with httpx.AsyncClient(timeout=60) as client:
            src_resp = await client.get(source_url)
            if not src_resp.is_success:
                await _update_task_status(task.id, "failed",
                    error=f"Failed to download source image: HTTP {src_resp.status_code}")
                return None
            src_bytes = src_resp.content

        # 2. Call inference service
        inference_url = app_settings.INFERENCE_SERVICE_URL.rstrip("/") + "/process/bg-removal"
        api_key = app_settings.INFERENCE_SERVICE_API_KEY

        async with httpx.AsyncClient(timeout=120) as client:
            headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
            files = {"file": ("input.png", src_bytes, "image/png")}
            data = {"model": "rembg"}
            resp = await client.post(inference_url, files=files, data=data, headers=headers)

            if not resp.is_success:
                err_detail = f"Inference service returned HTTP {resp.status_code}"
                try:
                    err_body = resp.json()
                    err_detail = err_body.get("detail", err_detail)
                except Exception:
                    pass
                await _update_task_status(task.id, "failed", error=err_detail)
                return None

            result_bytes = resp.content

        # 3. Upload result to local storage
        user_jwt = _make_user_jwt(task.user_id)
        async with httpx.AsyncClient(timeout=60) as client:
            upload_files = {"file": ("bg_removed.png", result_bytes, "image/png")}
            upload_headers = {"Authorization": f"Bearer {user_jwt}"} if user_jwt else {}
            save_resp = await client.post(
                f"{app_settings.PUBLIC_URL}/api/files/upload?category=generated",
                files=upload_files,
                headers=upload_headers,
            )
            if save_resp.is_success:
                data = save_resp.json()
                local_url = data.get("data", {}).get("url")
                if local_url:
                    await _update_task_status(task.id, "completed", result_url=local_url)
                    return local_url

            await _update_task_status(task.id, "failed", error="Failed to save processed image")
            return None

    except httpx.TimeoutException:
        await _update_task_status(task.id, "failed", error="Inference service timed out")
        return None
    except Exception as e:
        logger.error(f"bg_removal failed task={task.id} err={str(e)[:200]}")
        await _update_task_status(task.id, "failed", error=str(e)[:500])
        return None


async def _update_task_status(task_id: str, status: str, *, result_url: str | None = None, error: str | None = None) -> None:
    """Update task status. Skips if task was cancelled (don't overwrite cancel)."""
    async with _async_session() as db:
        now = datetime.now(timezone.utc)
        # Don't overwrite "failed" (cancelled) with "completed"
        if status == "completed":
            row = await db.execute(
                text("SELECT status FROM generation_tasks WHERE id = :id"),
                {"id": task_id},
            )
            current = row.scalar()
            if current == "failed":
                return  # task was cancelled, don't change status
        await db.execute(
            text("UPDATE generation_tasks SET status = :status, result_url = :url, error = :err, updated_at = :now WHERE id = :id"),
            {"status": status, "url": result_url or "", "err": error or "", "now": now, "id": task_id},
        )
        await db.commit()


# ── Zombie cleanup ─────────────────────────────────────────────


async def _cleanup_zombies(db: AsyncSession) -> None:
    """Mark tasks stuck in 'processing' for > STUCK_TIMEOUT_MIN as failed."""
    cutoff = datetime.now(timezone.utc)
    result = await db.execute(
        text("""
            UPDATE generation_tasks
            SET status = 'failed', error = 'Task timed out', updated_at = :now
            WHERE status = 'processing'
              AND updated_at < :cutoff
        """),
        {
            "now": cutoff,
            "cutoff": datetime.fromtimestamp(cutoff.timestamp() - STUCK_TIMEOUT_MIN * 60, tz=timezone.utc),
        },
    )
    if result.rowcount:
        logger.warning(f"cleaned up {result.rowcount} zombie task(s)")

    await db.commit()


# ── Main loop ──────────────────────────────────────────────────


async def worker_loop():
    """Main worker loop — runs as an asyncio background task."""
    await _ensure_wal()
    logger.info(f"worker started max_concurrency={MAX_CONCURRENCY} stuck_timeout={STUCK_TIMEOUT_MIN}min")

    semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
    active_tasks = 0
    zombie_tick = 0

    while True:
        try:
            # ── Zombie cleanup (every ZOMBIE_CHECK_INTERVAL seconds) ──
            zombie_tick += 1
            if zombie_tick >= ZOMBIE_CHECK_INTERVAL // POLL_INTERVAL_SEC:
                zombie_tick = 0
                async with _async_session() as db:
                    await _cleanup_zombies(db)

            # ── Claim pending tasks ──
            async with _async_session() as db:
                tasks = await _claim_tasks(db)
            if tasks:
                logger.debug(f"claimed {len(tasks)} task(s)")

            # ── Process tasks concurrently (Semaphore limits to MAX_CONCURRENCY) ──
            for task in tasks:
                async def _run(t=task):
                    async with semaphore:
                        await _process_task(t)

                asyncio.create_task(_run())

        except Exception as e:
            logger.error(f"loop error: {e}")

        await asyncio.sleep(POLL_INTERVAL_SEC)

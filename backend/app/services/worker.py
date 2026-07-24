"""
Background worker that processes generation tasks from the queue.
"""

import asyncio
import base64
import logging
import os
import time
from contextlib import nullcontext as _nullcontext
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.crud import task as crud_task
from app.database import async_session
from app.services.storage import save_upload_bytes

logger = logging.getLogger(__name__)
from app.models.task import GenerationTask
from app.services.providers import build_endpoint, detect_provider, download_and_save, is_async_provider

# ── Constants ───────────────────────────────────────────────────

POLL_INTERVAL_SEC = settings.WORKER_POLL_INTERVAL
MAX_CONCURRENCY = settings.WORKER_MAX_CONCURRENCY
STUCK_TIMEOUT_MIN = settings.WORKER_STUCK_TIMEOUT
API_TIMEOUT_SEC = settings.WORKER_API_TIMEOUT
ZOMBIE_CHECK_INTERVAL = settings.WORKER_ZOMBIE_INTERVAL

# ── Engine & session ──
# worker 复用 app.database 的共享 engine（单一连接池），避免自建第二个 engine
# 导致的双连接池 / WAL 不一致问题；WAL 在 lifespan 启动时统一开启。

# ── Atomic task claim ──────────────────────────────────────────


async def _claim_tasks(db: AsyncSession, limit: int = 10) -> list[GenerationTask]:
    """原子地批量领取最多 limit 条 pending 任务。

    委托 crud_task.claim_pending_tasks：声明式 update(...).returning(GenerationTask)
    返回 ORM 对象，config/ref_urls 已按模型声明反序列化为 dict/list，
    不再依赖手搓 SQL 的下标映射或 json.loads 补丁。
    """
    return await crud_task.claim_pending_tasks(db, limit)


# ── Resolve reference images to base64 ────────────────────────


_MEDIA_TYPE_MAP = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


def _read_self_file(url: str, user_id: int) -> tuple[bytes, str] | None:
    """同源文件 URL → 直接读本机磁盘，免出网（消除 hairpin）。

    仅接受 /api/files/{uid}/{sub}/{hash}{ext} 或 /api/files/{uid}/frames/{name} 形态。
    返回 (bytes, mime)，或 None（不读盘）。
    """
    from app.services import media

    if "/api/files/" not in url:
        return None
    rel = url.split("/api/files/", 1)[-1]
    parts = [p for p in rel.split("/") if p]
    if len(parts) < 3:
        return None
    try:
        uid = int(parts[0])
    except ValueError:
        return None
    sub = parts[1]
    if sub != "frames" and (len(sub) != 2 or not sub.isalnum()):
        return None
    if uid != user_id:
        logger.warning(f"read_self_file uid mismatch: url uid={uid} task uid={user_id}")
        return None
    try:
        full_path = media.validate_user_file(rel, user_id)
    except (FileNotFoundError, PermissionError, ValueError):
        return None
    # 双保险：realpath + 前缀守卫（防符号链接/逃逸）
    real = os.path.realpath(full_path)
    root = os.path.realpath(media.UPLOAD_DIR)
    if not (real == root or real.startswith(root + os.sep)):
        return None
    try:
        with open(real, "rb") as f:
            data = f.read()
    except OSError:
        return None
    ext = os.path.splitext(real)[1].lower()
    mime = _MEDIA_TYPE_MAP.get(ext, "application/octet-stream")
    return data, mime


async def _resolve_refs(ref_urls: list[str], user_id: int) -> list[str]:
    """Convert self/allowed file URLs to base64 data URLs (external providers can't reach localhost).

    三档：
      1) 同源 URL → 直接读本机磁盘转 base64（无出网，消除 hairpin）
      2) 白名单内 URL → dns_pin 安全 fetch 后转 base64
      3) 其它外链 → 透传原串（不下载，交由 provider 自行访问）
    """
    if not ref_urls:
        return []
    resolved: list[str] = []
    from app.services.ssrf import (
        is_self_url,
        is_allowed_ref_host,
        _validate_worker,
        dns_pin,
    )

    for url in ref_urls:
        # 1) 同源 → 读盘（无出网）
        if is_self_url(url):
            pair = _read_self_file(url, user_id)
            if pair:
                data, mime = pair
                b64 = base64.b64encode(data).decode()
                resolved.append(f"data:{mime};base64,{b64}")
                continue
        # 2) 白名单 → dns_pin 安全 fetch
        if is_allowed_ref_host(url):
            try:
                ip, hostname, scheme, port = _validate_worker(url)
            except Exception:
                resolved.append(url)
                continue
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    with dns_pin(hostname, ip, port):
                        resp = await client.get(url)
                if resp.is_success:
                    b64 = base64.b64encode(resp.content).decode()
                    mime = resp.headers.get("content-type", "image/png")
                    resolved.append(f"data:{mime};base64,{b64}")
                    continue
            except Exception:
                pass
        # 3) 其它外链 → 透传
        resolved.append(url)
    return resolved


# ── Process a single task ──────────────────────────────────────


async def _process_task(task: GenerationTask) -> None:
    """Process one task: call AI API, save result, update DB."""
    config = task.config or {}
    model = config.get("model", "")
    quality = config.get("quality", "auto")
    ratio = config.get("ratio", "1:1")
    size = config.get("size", "1K")
    n = config.get("n", 1)
    raw_refs = task.ref_urls or []
    refs = await _resolve_refs(raw_refs, task.user_id)

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
        async with async_session() as db:
            channel = await crud_mc.get_channel(db, channel_id_int, task.user_id)
        if not channel:
            await _update_task_status(task.id, "failed", error="Channel not found")
            return
        base_url, api_key = channel.base_url, channel.api_key

    provider = detect_provider(base_url)
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    # SSRF 校验：对 AI provider 的 base_url 解析并锁定 DNS，防御内网/元数据探测
    from app.services.ssrf import _validate_worker, dns_pin, SSREFError
    if base_url:
        try:
            ip, hostname, scheme, port = _validate_worker(base_url)
        except SSREFError as e:
            await _update_task_status(
                task.id, "failed", error=f"Invalid provider base_url: {e}"
            )
            return
    else:
        ip = hostname = scheme = port = None  # bg_removal 不发 provider 请求

    # dns_pin 是同步上下文管理器（@contextmanager），用 with；httpx 用 async with
    pin_ctx = dns_pin(hostname, ip, port) if hostname else _nullcontext()
    with pin_ctx:
        async with httpx.AsyncClient(timeout=API_TIMEOUT_SEC) as client:
            try:
                logger.info(f"processing task={task.id} type={task.type}")
                if task.type == "image":
                    result_urls, image_error = await _process_image(
                        client, provider, task, model, base_url, headers,
                        quality, ratio, size, n, refs,
                    )
                    already_handled = False
                elif task.type == "video":
                    result_url = await _process_video(
                        client, provider, task, model, base_url, headers,
                        ratio, refs,
                    )
                    result_urls = [result_url] if result_url else []
                    image_error = ""
                    already_handled = False
                elif task.type == "bg_removal":
                    result_url = await _process_bg_removal(task)
                    result_urls = [result_url] if result_url else []
                    image_error = ""
                    # bg_removal 失败路径已自行 _update_task_status 并 return None
                    already_handled = result_url is None
                else:
                    await _update_task_status(task.id, "failed", error=f"Unknown type: {task.type}")
                    return

                if result_urls:
                    # 批量下载 CDN 图并落本地（不携带 provider 凭证）；
                    # 部分下载失败也保留已成功的图，至少传一张就标 completed。
                    local_urls: list[str] = []
                    for u in result_urls:
                        local = await download_and_save(u, task.user_id, task.type, task_id=task.id)
                        if local:
                            local_urls.append(local)
                    # DEBUG: 追加测试多图 URL（开发环境用，模拟上游返回多张结果）
                    local_urls.extend([
                        "http://localhost:8000/api/files/1/7f/7f43023e55509bc70bbbb11b99ed8142df2b8590bd5c406d3a8300b89151a0b4.jpg",
                        "http://localhost:8000/api/files/1/dc/dc384da231088bf70e7cf83eff496da94f73bc3aa500ea5d6317770bb9228890.png",
                        "http://localhost:8000/api/files/1/34/34ccba4c1f1800bdf171e6d4a039571d6f62a68daad6aaa03ac16fa622f7ebda.png",
                    ])
                    if local_urls:
                        await _update_task_status(task.id, "completed", result_urls=local_urls)
                        logger.info(f"completed task={task.id} urls={len(local_urls)}")
                    else:
                        # 全部下载/存储失败：不把易失效的外链 url 存成结果
                        await _update_task_status(
                            task.id, "failed",
                            error=f"结果下载或本地存储失败，原始 url: {result_urls[0][:120]}",
                        )
                        logger.warning(f"download failed task={task.id} url={result_urls[0][:60]}")
                elif not already_handled:
                    # 优先透传 provider 返回的真实失败原因，否则兜底
                    fail_reason = image_error or "No result from provider"
                    await _update_task_status(task.id, "failed", error=fail_reason)
                    logger.warning(f"no result task={task.id} reason={fail_reason}")

            except asyncio.TimeoutError:
                logger.error(f"TIMEOUT task={task.id} type={task.type} url={base_url[:60]} model={model}"
                             f" timeout={API_TIMEOUT_SEC}s provider={type(provider).__name__}")
                await _update_task_status(task.id, "failed", error="API call timed out")
            except Exception as e:
                logger.error(f"error task={task.id} type={task.type} err={str(e)[:300]}")
                await _update_task_status(task.id, "failed", error=str(e)[:500])


async def _process_image(
    client, provider, task, model, base_url, headers,
    quality, ratio, size, n, refs,
) -> tuple[list[str], str]:
    """Call image generation API and return (cdn_urls, error_reason)。
    成功 -> (urls[], "")；失败 -> ([], reason)，reason 透传给上层写入 DB。
    支持一次返回多张图：urls 为结果 URL 列表。"""
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

        urls, raw_bytes = provider.extract_image(data)
        if urls:
            logger.info(f"image done task={task.id} took={int((time.perf_counter()-t0)*1000)}ms urls={len(urls)}")
            return urls, ""

        # provider 返回 b64 -> 解码后直落本地存储（可能多张）
        if raw_bytes:
            local_urls: list[str] = []
            for rb in raw_bytes:
                lu = await save_upload_bytes(user_id=task.user_id, content=rb, category="generated", ext="png")
                if lu:
                    local_urls.append(lu)
            if local_urls:
                logger.info(f"image done task={task.id} took={int((time.perf_counter()-t0)*1000)}ms (b64) urls={len(local_urls)}")
                return local_urls, ""
            logger.error(f"image base64 upload failed task={task.id}")
            return [], "结果图片本地存储失败"

        # 异步任务模式：提交后没有立即返回图片，走轮询
        task_id = provider.extract_image_task_id(data) if is_async_provider(provider) else None
        if task_id:
            poll_url = provider.build_image_poll_url(base_url, task_id)
            logger.info(f"image async task={task.id} task_id={task_id} poll_url={poll_url}")
            # 首次轮询前的初始等待（异步任务通常需要处理时间，前几次轮询多半 pending）
            initial_delay = getattr(settings, "WORKER_ASYNC_POLL_INITIAL_DELAY", 0.0) or 0.0
            if initial_delay > 0:
                logger.info(f"image async initial delay task={task.id} wait={initial_delay}s")
                await asyncio.sleep(initial_delay)
            poll_failed_reason = ""
            for attempt in range(provider.max_poll_attempts):
                await asyncio.sleep(provider.poll_interval / 1000)
                try:
                    poll_resp = await client.get(poll_url, headers=headers)
                    if not poll_resp.is_success:
                        logger.warning(f"image poll bad status task={task.id} attempt={attempt} status={poll_resp.status_code} task_id={task_id}")
                        continue
                    poll_data = poll_resp.json()
                    result = provider.extract_image_poll_result(poll_data)
                    if result == "__FAILED__":
                        reason = ""
                        if hasattr(provider, "extract_image_poll_error"):
                            reason = provider.extract_image_poll_error(poll_data) or ""
                        poll_failed_reason = reason or "上游任务执行失败"
                        logger.warning(f"image async failed task={task.id} task_id={task_id} reason={reason}")
                        break
                    if isinstance(result, list):
                        if result:
                            logger.info(f"image async done task={task.id} task_id={task_id} attempt={attempt} urls={len(result)}")
                            return result, ""
                    elif result:
                        # 单 URL 兜底（理论上已是 list，这里防御性包裹）
                        logger.info(f"image async done task={task.id} task_id={task_id} attempt={attempt}")
                        return [result], ""
                    # pending：每 5 次记一次进度，方便判断任务是否在推进
                    if attempt % 5 == 0:
                        payload = poll_data.get("data") if isinstance(poll_data, dict) and isinstance(poll_data.get("data"), dict) else poll_data
                        pstatus = str(payload.get("status") or payload.get("task_status") or "") if isinstance(payload, dict) else ""
                        progress = payload.get("progress") if isinstance(payload, dict) else None
                        logger.info(f"image polling task={task.id} attempt={attempt} status={pstatus} progress={progress} task_id={task_id}")
                except Exception as e:
                    logger.warning(f"image poll error task={task.id} attempt={attempt} err={str(e)[:80]}")
                    continue
            # 轮询结束仍未出图：优先用已捕获的失败原因，否则是超时
            if poll_failed_reason:
                logger.warning(f"image async failed task={task.id} task_id={task_id}")
                return [], poll_failed_reason
            logger.warning(f"image async timeout task={task.id} task_id={task_id}")
            return [], f"异步生图超时（task_id={task_id}）"

        logger.warning(f"image no result task={task.id} data_keys={list(data.keys())}")
        return [], "provider 未返回图片结果"
    except asyncio.TimeoutError:
        # 超时上下文由 _process_task 的 TimeoutError 分支统一记录，这里不重复
        raise
    except Exception:
        # 其他异常由 _process_task 的 Exception 分支统一记录，避免重复打日志
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
    if not ref_urls:
        await _update_task_status(task.id, "failed", error="No source image URL provided")
        return None

    source_url = ref_urls[0]

    try:
        # 1. SSRF 防护：同源读本机磁盘（无出网）；白名单内 dns_pin 安全下载；其它拒绝
        from app.services.ssrf import (
            is_self_url,
            is_allowed_ref_host,
            _validate_worker,
            dns_pin,
            SSREFError,
        )
        src_bytes = None
        if is_self_url(source_url):
            pair = _read_self_file(source_url, task.user_id)
            if pair:
                src_bytes = pair[0]
        if src_bytes is None and is_allowed_ref_host(source_url):
            try:
                ip, hostname, scheme, port = _validate_worker(source_url)
                async with httpx.AsyncClient(timeout=60) as client:
                    with dns_pin(hostname, ip, port):
                        src_resp = await client.get(source_url)
                if src_resp.is_success:
                    src_bytes = src_resp.content
                else:
                    await _update_task_status(
                        task.id, "failed",
                        error=f"Failed to download source image: HTTP {src_resp.status_code}",
                    )
                    return None
            except Exception as e:
                logger.warning(f"bg_removal download failed task={task.id}: {e}")
                src_bytes = None
        if src_bytes is None:
            await _update_task_status(
                task.id, "failed",
                error="Source image must be hosted on this service",
            )
            return None

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

        # 3. Upload result to local storage（直落，不再自调 HTTP / 伪造 JWT）
        local_url = await save_upload_bytes(
            user_id=task.user_id,
            content=result_bytes,
            category="generated",
            ext="png",
        )
        if local_url:
            # 不在此自标完成：交由 _process_task 统一写入 result_urls 列表
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


async def _update_task_status(task_id: str, status: str, *, result_urls: list[str] | None = None, error: str | None = None) -> None:
    """Update task status. Skips if task was cancelled (don't overwrite cancel)."""
    async with async_session() as db:
        await crud_task.update_task_status(
            db, task_id, status, result_urls=result_urls, error=error
        )


# ── Zombie cleanup ─────────────────────────────────────────────


async def _cleanup_zombies(db: AsyncSession) -> None:
    """Mark tasks stuck in 'processing' for > STUCK_TIMEOUT_MIN as failed."""
    now = datetime.now(timezone.utc)
    cutoff = datetime.fromtimestamp(
        now.timestamp() - STUCK_TIMEOUT_MIN * 60, tz=timezone.utc
    )
    n = await crud_task.cleanup_zombie_tasks(db, cutoff, now)
    if n:
        logger.warning(f"cleaned up {n} zombie task(s)")


# ── Main loop ──────────────────────────────────────────────────


async def worker_loop():
    """Main worker loop — runs as an asyncio background task."""
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
                async with async_session() as db:
                    await _cleanup_zombies(db)

            # ── Claim pending tasks ──
            async with async_session() as db:
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

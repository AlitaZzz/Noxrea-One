"""单任务生命周期执行。

编排：channel 解析 → SSRF 准备 → gateway 分发 / bg_removal → 结果存储 → 状态更新。
无业务逻辑、无 Provider 参数转换、无协议猜测。

存储统一在 _finalize_result 中处理，CapabilityService 返回 urls/files 后由 executor 落盘。

重构后使用 ChannelConfig 替代旧的 parse_channel_config 三元组。
"""

import asyncio
import logging
from contextlib import nullcontext as _nullcontext
from urllib.parse import urlparse

import httpx

from app.config import settings
from app.crud import task as crud_task
from app.database import async_session
from app.models.task import GenerationTask
from app.schemas.channel_config import ChannelConfig
from app.services.gateway.router import CapabilityRouter
from app.services.http import TIMEOUT_AI_GENERATE
from app.logging_config import log_event, classify_error
from app.services.storage.service import StorageService
from app.services.worker.context import ExecutionContext

logger = logging.getLogger(__name__)

API_TIMEOUT_SEC = settings.WORKER_API_TIMEOUT


# ── Status update ──────────────────────────────────────────────


async def update_task_status(
    task_id: str,
    status: str,
    *,
    result_urls: list[str] | None = None,
    result_text: str | None = None,
    error: str | None = None,
) -> None:
    """Update task status. Skips if task was cancelled."""
    async with async_session() as db:
        await crud_task.update_task_status(
            db, task_id, status, result_urls=result_urls, result_text=result_text, error=error
        )


# ── Single task lifecycle ──────────────────────────────────────


async def process_task(task: GenerationTask) -> None:
    """Process one task: call AI API / inference, save result, update DB."""
    config = task.config or {}
    model = config.get("model", "")
    capability = getattr(task, "capability", None) or task.type

    logger.info(log_event("executor", task_id=task.id, stage="processing",
                          type=task.type, model=model, prompt_len=len(task.prompt or "")))

    # 开发联调：mock 模式
    if settings.MOCK_IMAGE_GENERATE and task.type == "image":
        from app.services.capabilities.mock.service import process_mock_images
        await process_mock_images(task)
        return

    # bg_removal 走推理服务，不需要 channel
    if task.type == "bg_removal":
        await _process_bg_removal(task)
        return

    # ── 解析 channel ──
    channel_id = config.get("channel_id")
    try:
        channel_id_int = int(channel_id) if channel_id else 0
    except (TypeError, ValueError):
        channel_id_int = 0
    if not channel_id_int:
        await update_task_status(task.id, "failed", error="Missing or invalid channel_id in task config")
        logger.info(log_event("executor", task_id=task.id, stage="failed",
                              category="invalid_request", retry=False, message='"missing channel_id"'))
        return

    from app.crud import model_config as crud_mc
    async with async_session() as db:
        channel = await crud_mc.get_channel(db, channel_id_int, task.user_id)
    if not channel:
        await update_task_status(task.id, "failed", error="Channel not found")
        logger.info(log_event("executor", task_id=task.id, stage="failed",
                              category="invalid_request", retry=False, message='"channel not found"'))
        return

    base_url = channel.base_url
    api_key = channel.api_key
    protocol_name = channel.protocol or getattr(task, "protocol", None) or "openai"
    channel_config = ChannelConfig.parse(channel.config)

    provider = urlparse(base_url).hostname or base_url
    logger.info(log_event("executor", task_id=task.id, stage="dispatch",
                          provider=provider, channel=channel_id_int,
                          protocol=protocol_name, refs=len(task.ref_images or [])))

    # ── SSRF 校验 ──
    from app.services.ssrf import _validate_worker, dns_pin, SSREFError
    try:
        ip, hostname, scheme, port = _validate_worker(base_url)
    except SSREFError as e:
        await update_task_status(task.id, "failed", error=f"Invalid provider base_url: {e}")
        logger.info(log_event("executor", task_id=task.id, stage="failed",
                              category="invalid_request", retry=False, message=f'"SSRF rejected: {e}"'))
        return

    pin_ctx = dns_pin(hostname, ip, port) if hostname else _nullcontext()
    with pin_ctx:
        async with httpx.AsyncClient(timeout=TIMEOUT_AI_GENERATE) as client:
            try:
                ctx = ExecutionContext(
                    task=task,
                    config=config,
                    model=model,
                    base_url=base_url,
                    api_key=api_key,
                    protocol=protocol_name,
                    capability=capability,
                    channel_config=channel_config,
                )
                result_urls, error_reason, metadata = await _process_via_gateway(client, ctx)

                await _finalize_result(task, result_urls, error_reason, metadata)

            except asyncio.TimeoutError:
                category, _ = classify_error("timeout")
                logger.info(log_event("executor", task_id=task.id, stage="failed",
                                      category=category, retry=True, duration=f"{API_TIMEOUT_SEC}s"))
                await update_task_status(task.id, "failed", error="API call timed out")
            except httpx.TimeoutException as e:
                timeout_type = type(e).__name__
                detail = str(e) or "timed out"
                msg = f"Provider {timeout_type}: {detail}"
                logger.info(log_event("executor", task_id=task.id, stage="failed",
                                      category="timeout", retry=True, message=f'"{msg}"'))
                await update_task_status(task.id, "failed", error=msg)
            except Exception as e:
                logger.info(log_event("executor", task_id=task.id, stage="failed",
                                      category="protocol_error", retry=False, message=f'"{str(e)[:200]}"'))
                await update_task_status(task.id, "failed", error=str(e)[:500])


async def _process_bg_removal(task: GenerationTask) -> None:
    """处理背景移除任务。"""
    from app.services.inference.bg_removal import process as run_bg_removal

    result_url, bg_error = await run_bg_removal(task)
    result_urls = [result_url] if result_url else []
    await _finalize_result(task, result_urls, bg_error or "", {})


async def _finalize_result(
    task: GenerationTask, result_urls: list[str], error_reason: str, metadata: dict
) -> None:
    """结果处理：下载落本地 → 更新完成/失败状态。

    统一入口：所有 capability（image/video/audio/llm/bg_removal）
    的结果存储都在此处处理。
    """
    capability = getattr(task, "capability", None) or task.type

    # LLM 文本结果：直接写入 result_text，不走 URL 下载
    if not result_urls and capability == "llm" and metadata.get("text"):
        text = metadata["text"]
        await update_task_status(task.id, "completed", result_text=text)
        logger.info(log_event("executor", task_id=task.id, stage="completed",
                              text_len=len(text)))
        return

    if result_urls:
        # 批量下载 CDN 图并落本地
        local_urls: list[str] = []
        for u in result_urls:
            local = await StorageService.download_and_save(u, task.user_id, capability, task_id=task.id)
            if local:
                local_urls.append(local)

        if local_urls:
            await update_task_status(task.id, "completed", result_urls=local_urls)
            logger.info(log_event("executor", task_id=task.id, stage="storage_saved",
                                  local_urls=len(local_urls)))
        else:
            await update_task_status(
                task.id, "failed",
                error=f"结果下载或本地存储失败，原始 url: {result_urls[0][:120]}",
            )
            logger.info(log_event("executor", task_id=task.id, stage="storage_failed",
                                  category="storage_error", retry=False, message='"download failed"'))
    else:
        fail_reason = error_reason or "No result from provider"
        raw_sample = (metadata or {}).get("raw_sample") or ""
        if raw_sample:
            fail_reason = f"{fail_reason} | upstream_response={raw_sample[:300]}"
        await update_task_status(task.id, "failed", error=fail_reason)
        logger.info(log_event("executor", task_id=task.id, stage="failed",
                              category="protocol_error", retry=False, message=f'"{fail_reason}"'))


async def _process_via_gateway(client, ctx: ExecutionContext) -> tuple[list[str], str, dict]:
    """通过 CapabilityRouter 处理任务。

    返回 (local_urls, error_reason, metadata)。
    """
    task = ctx.task
    capability = ctx.capability or task.type
    protocol_name = ctx.protocol or "openai"

    # 从 config 提取纯业务参数
    from app.services.capabilities.params import extract_execution_params
    params = extract_execution_params(task.config)

    # 参考图解析（前置到 gateway 调用前，但由 resolver 模块处理）
    from app.services.resolvers.reference import resolve_refs
    refs = await resolve_refs(task.ref_images or [], task.user_id)

    result = await CapabilityRouter.dispatch(
        capability=capability,
        task_id=task.id,
        user_id=task.user_id,
        prompt=task.prompt or "",
        params=params,
        base_url=ctx.base_url,
        api_key=ctx.api_key,
        protocol_name=protocol_name,
        channel_config=ctx.channel_config,
        model=ctx.model,
        ref_images=refs,
    )

    if result.get("status") == "completed":
        urls = result.get("urls") or []
        files = result.get("files") or []
        metadata = result.get("metadata") or {}

        local_urls: list[str] = []

        # 处理 URL（下载外链落本地）
        for u in urls:
            if u.startswith("http://") or u.startswith("https://"):
                local = await StorageService.download_and_save(
                    u, task.user_id, capability, task_id=task.id
                )
                if local:
                    local_urls.append(local)
            elif u.startswith("data:"):
                # base64 data URL → 存为 bytes
                import base64
                try:
                    header, b64_data = u.split(",", 1)
                    content = base64.b64decode(b64_data)
                    ext = "png" if "png" in header else "jpg"
                    local = await StorageService.save_bytes(
                        content, task.user_id, ext=ext, category="generated"
                    )
                    if local:
                        local_urls.append(local)
                except Exception:
                    pass
            else:
                local_urls.append(u)

        # 处理 files（raw bytes，如 TTS 音频）
        for f_item in files:
            if isinstance(f_item, tuple) and len(f_item) == 2:
                content, ext = f_item
            elif isinstance(f_item, bytes):
                content, ext = f_item, "png"
            else:
                continue
            local = await StorageService.save_bytes(
                content, task.user_id, ext=ext, category="generated"
            )
            if local:
                local_urls.append(local)

        return local_urls, "", metadata
    else:
        error = result.get("error", "Gateway processing failed")
        metadata = result.get("metadata") or {}
        return [], error, metadata

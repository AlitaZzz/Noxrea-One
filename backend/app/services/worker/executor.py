"""单任务生命周期执行。

编排：channel 解析 -> SSRF 准备 -> gateway 分发 -> 结果存储 -> 状态更新。
无业务逻辑、无 Provider 参数转换、无协议猜测。

存储统一在 _finalize_result 中处理，CapabilityService 返回 CapabilityResult 后由 executor 落盘。
内部能力（如 bg_removal）无 channel，直接走 gateway 分发。
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
from app.services.capabilities.base import CapabilityResult
from app.services.events.bus import event_bus
from app.services.events.types import EventType, TaskEvent
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
) -> bool:
    """Update task status. Skips if task was cancelled. Returns True if updated."""
    async with async_session() as db:
        return await crud_task.update_task_status(
            db, task_id, status, result_urls=result_urls, result_text=result_text, error=error
        )


async def update_and_emit(
    task: GenerationTask,
    status: str,
    *,
    result_urls: list[str] | None = None,
    result_text: str | None = None,
    error: str | None = None,
) -> None:
    """更新任务状态 + 发布事件到 EventBus。

    如果 DB 更新因取消保护被跳过（task 已被 cancel），则不发布事件。
    """
    updated = await update_task_status(
        task.id, status,
        result_urls=result_urls, result_text=result_text, error=error,
    )
    if not updated:
        return

    event_data: dict = {"status": status}
    if result_urls is not None:
        event_data["result_urls"] = result_urls
    if result_text is not None:
        event_data["result_text"] = result_text
    if error is not None:
        event_data["error"] = error

    if status == "completed":
        event_type = EventType.TASK_COMPLETED
    elif status == "failed":
        event_type = EventType.TASK_FAILED
    else:
        event_type = EventType.TASK_PROCESSING

    capability = task.effective_capability
    await event_bus.publish(TaskEvent(
        event_type=event_type,
        task_id=task.id,
        user_id=task.user_id,
        capability=capability,
        data=event_data,
    ))


# ── Single task lifecycle ──────────────────────────────────────


async def process_task(task: GenerationTask) -> None:
    """Process one task: call AI API / inference, save result, update DB."""
    config = task.config or {}
    model = config.get("model", "")
    capability = task.effective_capability

    logger.info(log_event("executor", task_id=task.id, stage="processing",
                          type=task.type, model=model, prompt_len=len(task.prompt or "")))

    # 开发联调：mock 模式
    if settings.MOCK_IMAGE_GENERATE and task.type == "image":
        from app.services.capabilities.mock.service import process_mock_images
        await process_mock_images(task)
        return

    # ── 解析 channel ──
    channel_id = config.get("channel_id")
    try:
        channel_id_int = int(channel_id) if channel_id else 0
    except (TypeError, ValueError):
        channel_id_int = 0

    if channel_id_int > 0:
        # 有 channel：解析渠道信息
        from app.crud import model_config as crud_mc
        async with async_session() as db:
            channel = await crud_mc.get_channel(db, channel_id_int, task.user_id)
        if not channel:
            await update_and_emit(task, "failed", error="Channel not found")
            logger.info(log_event("executor", task_id=task.id, stage="failed",
                                  category="invalid_request", retry=False, message='"channel not found"'))
            return

        base_url = channel.base_url
        api_key = channel.api_key
        protocol_name = task.protocol or "openai"
        channel_config = ChannelConfig.parse(channel.config)

        # SSRF 校验
        from app.services.ssrf import _validate_worker, dns_pin, SSREFError
        try:
            ip, hostname, scheme, port = _validate_worker(base_url)
        except SSREFError as e:
            await update_and_emit(task, "failed", error=f"Invalid provider base_url: {e}")
            logger.info(log_event("executor", task_id=task.id, stage="failed",
                                  category="invalid_request", retry=False, message=f'"SSRF rejected: {e}"'))
            return

        pin_ctx = dns_pin(hostname, ip, port) if hostname else _nullcontext()
        provider = urlparse(base_url).hostname or base_url
    else:
        # 无 channel：内部能力（如 bg_removal），直接走 gateway 分发
        base_url = ""
        api_key = ""
        protocol_name = task.protocol or ""
        channel_config = ChannelConfig()
        pin_ctx = _nullcontext()
        provider = "internal"

    logger.info(log_event("executor", task_id=task.id, stage="dispatch",
                          provider=provider, channel=channel_id_int,
                          protocol=protocol_name, refs=len(task.ref_images or [])))

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
                await update_and_emit(task, "failed", error="API call timed out")
            except httpx.TimeoutException as e:
                timeout_type = type(e).__name__
                detail = str(e) or "timed out"
                msg = f"Provider {timeout_type}: {detail}"
                logger.info(log_event("executor", task_id=task.id, stage="failed",
                                      category="timeout", retry=True, message=f'"{msg}"'))
                await update_and_emit(task, "failed", error=msg)
            except Exception as e:
                logger.info(log_event("executor", task_id=task.id, stage="failed",
                                      category="protocol_error", retry=False, message=f'"{str(e)[:200]}"'))
                await update_and_emit(task, "failed", error=str(e)[:500])


async def _finalize_result(
    task: GenerationTask, result_urls: list[str], error_reason: str, metadata: dict
) -> None:
    """结果处理：下载落本地 -> 更新完成/失败状态。

    统一入口：所有 capability（image/video/audio/llm/bg_removal）
    的结果存储都在此处处理。
    """
    capability = task.effective_capability

    # LLM 文本结果：直接写入 result_text，不走 URL 下载
    if not result_urls and capability == "llm" and metadata.get("text"):
        text = metadata["text"]
        await update_and_emit(task, "completed", result_text=text)
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
            await update_and_emit(task, "completed", result_urls=local_urls)
            logger.info(log_event("executor", task_id=task.id, stage="storage_saved",
                                  local_urls=len(local_urls)))
        else:
            await update_and_emit(
                task, "failed",
                error=f"结果下载或本地存储失败，原始 url: {result_urls[0][:120]}",
            )
            logger.info(log_event("executor", task_id=task.id, stage="storage_failed",
                                  category="storage_error", retry=False, message='"download failed"'))
    else:
        fail_reason = error_reason or "No result from provider"
        raw_sample = (metadata or {}).get("raw_sample") or ""
        if raw_sample:
            fail_reason = f"{fail_reason} | upstream_response={raw_sample[:300]}"
        await update_and_emit(task, "failed", error=fail_reason)
        logger.info(log_event("executor", task_id=task.id, stage="failed",
                              category="protocol_error", retry=False, message=f'"{fail_reason}"'))


async def _process_via_gateway(client, ctx: ExecutionContext) -> tuple[list[str], str, dict]:
    """通过 CapabilityRouter 处理任务。

    返回 (local_urls, error_reason, metadata)。
    """
    task = ctx.task
    capability = ctx.capability or task.effective_capability
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

    if result.status == "completed":
        urls = result.urls
        files = result.files
        metadata = result.metadata

        local_urls: list[str] = []

        # HTTP/HTTPS URL: 透传给 _finalize_result 统一下载（避免重复下载）
        # data: URL 和 files (raw bytes): 立即落盘（_finalize_result 不处理这两种格式）
        for u in urls:
            if u.startswith("data:"):
                # base64 data URL -> 存为 bytes
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
                # HTTP/HTTPS URL 或本地路径，透传给 _finalize_result
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
        error = result.error or "Gateway processing failed"
        metadata = result.metadata
        return [], error, metadata

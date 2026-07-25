"""背景移除：内部推理服务封装。

本模块不经过 Gateway / CapabilityRouter / Adapter / Protocol / Provider，
直接调用可信推理服务（INFERENCE_SERVICE_URL）。它是纯粹的“推理调用 + 结果落盘”
封装，不触碰任务状态；由 executor 负责调用并根据返回值统一更新任务状态。

process(task) -> (local_url | None, error | None)
  - 成功：(本地 URL, None)
  - 失败：(None, 错误文案)
"""

import asyncio
import logging

import httpx

from app.config import settings
from app.models.task import GenerationTask
from app.services.http import TIMEOUT_DOWNLOAD, TIMEOUT_INFERENCE
from app.services.resolvers.reference import read_self_file
from app.services.storage import save_upload_bytes

logger = logging.getLogger(__name__)


async def process(task: GenerationTask) -> tuple[str | None, str | None]:
    """处理 bg_removal 任务：获取源图 → 调推理服务 → 结果落本地。"""
    ref_urls = task.ref_urls or []
    if not ref_urls:
        return None, "No source image URL provided"

    source_url = ref_urls[0]

    try:
        # 1. SSRF 防护：同源读本机磁盘（无出网）；白名单内 dns_pin 安全下载；其它拒绝
        from app.services.ssrf import (
            is_self_url,
            is_allowed_ref_host,
            _validate_worker,
            dns_pin,
        )

        src_bytes = None
        if is_self_url(source_url):
            pair = read_self_file(source_url, task.user_id)
            if pair:
                src_bytes = pair[0]
        if src_bytes is None and is_allowed_ref_host(source_url):
            try:
                ip, hostname, scheme, port = _validate_worker(source_url)
                async with httpx.AsyncClient(timeout=TIMEOUT_DOWNLOAD) as client:
                    with dns_pin(hostname, ip, port):
                        src_resp = await asyncio.wait_for(
                            client.get(source_url),
                            timeout=settings.HTTP_DL_READ,
                        )
                if src_resp.is_success:
                    src_bytes = src_resp.content
                else:
                    return None, f"Failed to download source image: HTTP {src_resp.status_code}"
            except Exception as e:
                logger.warning(f"bg_removal download failed task={task.id}: {e}")
                src_bytes = None
        if src_bytes is None:
            return None, "Source image must be hosted on this service"

        # 2. Call inference service
        inference_url = settings.INFERENCE_SERVICE_URL.rstrip("/") + "/process/bg-removal"
        api_key = settings.INFERENCE_SERVICE_API_KEY

        async with httpx.AsyncClient(timeout=TIMEOUT_INFERENCE) as client:
            headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
            files = {"file": ("input.png", src_bytes, "image/png")}
            data = {"model": "rembg"}
            resp = await asyncio.wait_for(
                client.post(inference_url, files=files, data=data, headers=headers),
                timeout=settings.HTTP_TIMEOUT_INFERENCE,
            )

            if not resp.is_success:
                err_detail = f"Inference service returned HTTP {resp.status_code}"
                try:
                    err_body = resp.json()
                    err_detail = err_body.get("detail", err_detail)
                except Exception:
                    pass
                return None, err_detail

            result_bytes = resp.content

        # 3. Upload result to local storage（直落，不再自调 HTTP / 伪造 JWT）
        local_url = await save_upload_bytes(
            user_id=task.user_id,
            content=result_bytes,
            category="generated",
            ext="png",
        )
        if local_url:
            return local_url, None

        return None, "Failed to save processed image"

    except httpx.TimeoutException:
        return None, "Inference service timed out"
    except Exception as e:
        logger.error(f"bg_removal failed task={task.id} err={str(e)[:200]}")
        return None, str(e)[:500]

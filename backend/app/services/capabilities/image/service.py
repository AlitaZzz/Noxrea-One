"""
ImageService — 图片生成能力服务。

调用链：
  ImageService.execute()
      → 构建 ImageRequest（业务语义：size_level / ratio / quality / n / ref_urls）
      → AdapterRegistry.get(adapter_name) → adapt_params()
      → apply_parameter_mapping() + apply_override_json()（渠道自定义）
      → ProtocolRegistry.get(protocol_name, "image") → build_request()
      → TaskManager.submit_and_wait()

职责边界：
- 本 Service 只处理业务语义，禁止生成任何 Provider 参数。
- 存储/下载由 executor 统一处理，本 Service 不保存 bytes。
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import ValidationError

from app.config import settings
from app.services.capabilities.base import BaseCapabilityService
from app.services.capabilities.requests import ImageRequest
from app.services.adapters.base import AdapterRegistry
from app.services.adapters.mapping import (
    apply_parameter_mapping,
    apply_override_json,
    get_endpoint_override,
)
from app.services.protocols.base import ProtocolRegistry
from app.services.tasks.manager import TaskManager

logger = logging.getLogger(__name__)


class ImageService(BaseCapabilityService):
    """图片生成能力服务。

    不感知厂商（OpenAI/Gemini/Ark），通过注册表动态查找协议和适配器。
    """

    capability: str = "image"

    async def execute(
        self,
        *,
        task_id: str,
        user_id: int,
        prompt: str,
        params: dict,
        base_url: str,
        api_key: str,
        protocol_name: str,
        adapter_name: str = "",
        model: str = "",
        ref_urls: list[str] | None = None,
        parameter_mapping: dict | None = None,
        endpoint_mapping: dict | None = None,
        override_json: dict | None = None,
    ) -> dict[str, Any]:
        """执行图片生成。"""
        logger.info(
            f"[service] task={task_id} image execute protocol={protocol_name} "
            f"adapter={adapter_name} model={model} ref_count={len(ref_urls or [])}"
        )

        # ── 第 1 层：构建 Capability Internal Request（业务语义，无厂商字段） ──
        try:
            req = ImageRequest(
                model=model,
                prompt=prompt,
                size_level=params.get("size", "1K"),
                ratio=params.get("ratio", "1:1"),
                quality=params.get("quality", "auto"),
                n=params.get("n", 1),
                ref_urls=ref_urls,
            )
        except ValidationError as e:
            logger.warning("image request 校验失败 task=%s: %s", task_id, e)
            return {
                "status": "failed",
                "urls": [],
                "error": f"参数校验失败: {e}",
                "metadata": {},
            }

        internal = req.model_dump()

        # ── 第 2 层：Adapter 把内部请求转换为 Provider 请求（厂商差异） ──
        provider_body = AdapterRegistry.apply(adapter_name, internal, self.capability)

        # ── 第 2.5 层：渠道自定义字段映射 ──
        provider_body = apply_parameter_mapping(provider_body, parameter_mapping)
        provider_body = apply_override_json(provider_body, override_json)

        # ── 第 3 层：Protocol 仅负责 HTTP 通信 ──
        protocol = ProtocolRegistry.get(protocol_name, self.capability)
        if not protocol:
            return {
                "status": "failed",
                "urls": [],
                "error": f"Protocol '{protocol_name}' does not support image",
                "metadata": {},
            }

        endpoint, headers, request_body = protocol.build_request(
            base_url, api_key, provider_body, self.capability
        )

        # 渠道自定义端点覆盖
        # 无参考图（纯文本生图）→ image.generations；有参考图（图生图/编辑）→ image.edits
        operation = "image.edits" if ref_urls else "image.generations"
        override_endpoint = get_endpoint_override(endpoint_mapping, operation)
        if override_endpoint:
            endpoint = base_url.rstrip("/") + override_endpoint

        logger.info(f"[service] task={task_id} adapter applied endpoint={endpoint[:80]}")

        # ── TaskManager: 提交 + 同步优先异步兜底 ──
        result = await TaskManager.submit_and_wait(
            task_id=task_id,
            user_id=user_id,
            protocol=protocol,
            capability=self.capability,
            base_url=base_url,
            api_key=api_key,
            endpoint=endpoint,
            headers=headers,
            body=request_body,
            poll_interval=settings.WORKER_ASYNC_POLL_INTERVAL,
            max_poll_attempts=settings.WORKER_ASYNC_POLL_MAX_ATTEMPTS,
            initial_delay=settings.WORKER_ASYNC_POLL_INITIAL_DELAY,
        )

        # 注意：files/urls 统一由 executor._finalize_result 处理下载落盘，
        # 本 Service 不再调用 StorageService.save_bytes。
        return result


# ── CapabilityRegistry 注册 ─────────────────────────────────

def register():
    """注册 ImageService 到全局能力注册表。"""
    from app.services.capabilities.base import CapabilityRegistry
    CapabilityRegistry.register("image", ImageService())

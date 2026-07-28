"""
ImageService — 图片生成能力服务。

调用链（重构后）：
  ImageService.execute()
      → 构建 ImageRequest（业务参数：resolution / ratio / quality / n / ref_images）
      → request_builder.engine.build()（mapping → transforms → patch）
      → ProtocolRegistry.get(protocol_name, "image") → build_request()
      → TaskManager.submit_and_wait()

职责边界：
- 本 Service 只处理业务语义，禁止生成任何 Provider 参数。
- 存储/下载由 executor 统一处理，本 Service 不保存 bytes。
"""

from __future__ import annotations

import logging

from pydantic import ValidationError

from app.config import settings
from app.schemas.channel_config import ChannelConfig
from app.services.capabilities.base import BaseCapabilityService, CapabilityResult
from app.services.capabilities.requests import ImageRequest
from app.services.request_builder import build
from app.logging_config import log_event, run_upstream
from app.services.protocols.base import ProtocolRegistry
from app.services.tasks.manager import TaskManager

logger = logging.getLogger(__name__)


class ImageService(BaseCapabilityService):
    """图片生成能力服务。

    不感知厂商（OpenAI/Gemini/Ark），通过注册表动态查找协议，
    通过 request_builder + ChannelConfig 统一生成 Provider 请求体。
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
        channel_config: ChannelConfig = ChannelConfig(),
        model: str = "",
        ref_images: list[str] | None = None,
    ) -> CapabilityResult:
        """执行图片生成。"""

        # ── 第 1 层：构建 Capability Internal Request（业务参数） ──
        try:
            req = ImageRequest(
                model=model,
                prompt=prompt,
                resolution=params.get("resolution"),
                ratio=params.get("ratio"),
                quality=params.get("quality"),
                n=params.get("n", 1),
                ref_images=ref_images,
            )
        except ValidationError as e:
            logger.info(log_event(self.capability, task_id=task_id, stage="failed",
                                  category="invalid_request", retry=False, message=f'"{e}"'))
            return CapabilityResult.failed(f"参数校验失败: {e}")

        internal = req.model_dump()

        # ── 第 2 层：request_builder 一步完成 body 构造（mapping → transforms → patch） ──
        provider_body = build(internal, channel_config, self.capability, model_name=model, task_id=task_id)

        # ── 第 3 层：Protocol 仅负责 HTTP 通信 ──
        protocol = ProtocolRegistry.get(protocol_name, self.capability)
        if not protocol:
            return CapabilityResult.failed(
                f"Protocol '{protocol_name}' does not support image"
            )

        endpoint, headers, request_body = protocol.build_request(
            base_url, api_key, provider_body, self.capability
        )

        # 渠道自定义端点覆盖（从 ChannelConfig 读取）
        # 无参考图（纯文本生图）→ image.generations；有参考图（图生图/编辑）→ image.edits
        operation = "image.edits" if ref_images else "image.generations"
        override = channel_config.get_endpoint_override(operation)
        if override:
            endpoint = base_url.rstrip("/") + override
        elif ref_images:
            # 无手动覆盖但有参考图：自动把 /images/generations 替换为 /images/edits
            endpoint = endpoint.replace("/images/generations", "/images/edits")

        # ── TaskManager: 提交 + 同步优先异步兜底 ──
        result = await run_upstream(
            logger, self.capability, task_id, endpoint,
            TaskManager.submit_and_wait(
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
            ),
        )

        # 注意：files/urls 统一由 executor._finalize_result 处理下载落盘，
        # 本 Service 不再调用 StorageService.save_bytes。
        return CapabilityResult.from_dict(result)


# ── CapabilityRegistry 注册 ─────────────────────────────────

def register():
    """注册 ImageService 到全局能力注册表。"""
    from app.services.capabilities.base import CapabilityRegistry
    CapabilityRegistry.register("image", ImageService())

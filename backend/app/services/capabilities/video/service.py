"""
VideoService — 视频生成能力服务。

调用链（重构后）：
  VideoService.execute()
      → 构建 VideoRequest（业务参数：resolution / ratio / seconds / frame_rate）
      → request_builder.engine.build()（mapping → transforms → patch）
      → ProtocolRegistry.get(protocol_name, "video") → build_request()
      → TaskManager.submit_and_wait()
"""

from __future__ import annotations

import logging
from typing import Any

from app.config import settings
from app.schemas.channel_config import ChannelConfig
from app.services.capabilities.base import BaseCapabilityService
from app.services.request_builder import build
from app.logging_config import log_event, run_upstream
from app.services.protocols.base import ProtocolRegistry
from app.services.tasks.manager import TaskManager

logger = logging.getLogger(__name__)


class VideoService(BaseCapabilityService):
    """视频生成能力服务。"""

    capability: str = "video"

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
    ) -> dict[str, Any]:
        """执行视频生成。"""
        # 1. 准备基础参数（业务语义）
        body = {
            "model": model,
            "prompt": prompt,
            "resolution": params.get("resolution"),
            "ratio": params.get("ratio"),
            "seconds": params.get("seconds", 5),
        }

        if "frame_rate" in params:
            body["frame_rate"] = params["frame_rate"]

        if ref_images:
            body["ref_images"] = ref_images

        # 2. request_builder 一步完成 body 构造（mapping → transforms → patch）
        body = build(body, channel_config, self.capability, model_name=model, task_id=task_id)

        # 3. Protocol: 构造请求
        protocol = ProtocolRegistry.get(protocol_name, self.capability)
        if not protocol:
            return {
                "status": "failed",
                "urls": [],
                "error": f"Protocol '{protocol_name}' does not support video",
                "metadata": {},
            }

        endpoint, headers, request_body = protocol.build_request(
            base_url, api_key, body, self.capability
        )

        # 渠道自定义端点覆盖
        override = channel_config.get_endpoint_override("video.generate")
        if override:
            endpoint = base_url.rstrip("/") + override

        # 4. TaskManager: 提交 + 轮询
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
                initial_delay=2.0,
            ),
        )

        return result


# ── CapabilityRegistry 注册 ─────────────────────────────────

def register():
    """注册 VideoService 到全局能力注册表。"""
    from app.services.capabilities.base import CapabilityRegistry
    CapabilityRegistry.register("video", VideoService())

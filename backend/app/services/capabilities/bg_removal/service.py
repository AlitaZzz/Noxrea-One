"""BgRemovalService - 背景移除能力服务。

作为内部能力注册到 CapabilityRegistry，通过 Gateway 统一分发。
实际推理逻辑委托给 inference/bg_removal.py:remove_bg()。
"""

from __future__ import annotations

import logging

from app.schemas.channel_config import ChannelConfig
from app.services.capabilities.base import BaseCapabilityService, CapabilityResult

logger = logging.getLogger(__name__)


class BgRemovalService(BaseCapabilityService):
    """背景移除能力服务（内部推理，不需要外部渠道）。"""

    capability: str = "bg_removal"

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
        """执行背景移除。

        调用内部推理服务，不需要外部渠道（base_url / api_key / protocol_name 均为空）。
        """
        if not ref_images:
            return CapabilityResult.failed("bg_removal requires at least one reference image")

        from app.services.inference.bg_removal import remove_bg
        local_url, error = await remove_bg(ref_images[0], user_id)

        if error:
            return CapabilityResult.failed(error)

        return CapabilityResult.completed(urls=[local_url])


# ── CapabilityRegistry 注册 ─────────────────────────────────

def register():
    """注册 BgRemovalService 到全局能力注册表。"""
    from app.services.capabilities.base import CapabilityRegistry
    CapabilityRegistry.register("bg_removal", BgRemovalService())

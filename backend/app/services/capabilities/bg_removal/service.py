"""
BgRemovalService — 背景移除能力服务。

不经过 Gateway / Adapter / Protocol，直接调用内部推理服务。
返回结果由 executor 统一更新任务状态。
"""

from __future__ import annotations

import logging
from typing import Any

from app.schemas.channel_config import ChannelConfig
from app.services.capabilities.base import BaseCapabilityService

logger = logging.getLogger(__name__)


class BgRemovalService(BaseCapabilityService):
    """背景移除能力服务。"""

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
    ) -> dict[str, Any]:
        """执行背景移除。

        实际调用在 executor._process_bg_removal 中完成（需要 task 对象获取 ref_images），
        此处仅作为能力占位注册。
        """
        return {
            "status": "failed",
            "urls": [],
            "error": "BgRemoval 由 executor 直接处理，不走 Gateway 分发",
            "metadata": {},
        }


# ── CapabilityRegistry 注册 ─────────────────────────────────

def register():
    """注册 BgRemovalService 到全局能力注册表（仅作为能力声明占位）。"""
    from app.services.capabilities.base import CapabilityRegistry
    CapabilityRegistry.register("bg_removal", BgRemovalService())

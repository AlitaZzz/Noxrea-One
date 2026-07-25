
"""
CapabilityRouter — 网关路由分发。

根据 capability 动态查找 CapabilityService，不硬编码 if/else。

调用链（重构后）：
  CapabilityRouter.dispatch(capability, ...)
      → CapabilityRegistry.get(capability)
          → BaseCapabilityService.execute(protocol_name, channel_config, ...)

Worker 传入的 channel 配置（ChannelConfig）由本层透传到 CapabilityService。
"""

from __future__ import annotations

import logging

from app.logging_config import log_event
from app.schemas.channel_config import ChannelConfig
from app.services.capabilities.base import BaseCapabilityService, CapabilityRegistry

logger = logging.getLogger(__name__)


class CapabilityRouter:
    """网关路由：按 capability 名称动态分发到对应能力服务。"""

    @staticmethod
    async def dispatch(
        capability: str,
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
        ref_urls: list[str] | None = None,
    ) -> dict:
        """分发到对应能力服务并执行。

        Returns:
            {
                "status": "completed" | "failed" | "processing",
                "urls": [...],
                "error": "...",
                "upstream_task_id": "...",
                "metadata": {...},
            }
        """
        if not CapabilityRegistry.has(capability):
            logger.warning(log_event("gateway", task_id=task_id, stage="failed",
                                     category="invalid_request", message=f'"unknown capability: {capability}"'))
            return {
                "status": "failed",
                "urls": [],
                "error": f"Unknown capability: {capability}",
                "metadata": {},
            }

        service: BaseCapabilityService = CapabilityRegistry.get(capability)
        logger.info(log_event("gateway", task_id=task_id, stage="route",
                              capability=capability, model=model, protocol=protocol_name))
        return await service.execute(
            task_id=task_id,
            user_id=user_id,
            prompt=prompt,
            params=params,
            base_url=base_url,
            api_key=api_key,
            protocol_name=protocol_name,
            channel_config=channel_config,
            model=model,
            ref_urls=ref_urls,
        )

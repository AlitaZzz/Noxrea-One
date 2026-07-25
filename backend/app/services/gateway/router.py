"""
CapabilityRouter — 网关路由分发。

根据 capability 动态查找 CapabilityService，不硬编码 if/else。

调用链：
  CapabilityRouter.dispatch(capability, adapter_name, ...)
      → CapabilityRegistry.get(capability)
          → BaseCapabilityService.execute(adapter_name, ...)

Worker 传入的 channel 配置（protocol / adapter / mappings）由本层透传到 CapabilityService。
"""

from __future__ import annotations

import logging

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
        adapter_name: str = "",
        model: str = "",
        ref_urls: list[str] | None = None,
        parameter_mapping: dict | None = None,
        endpoint_mapping: dict | None = None,
        override_json: dict | None = None,
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
            logger.warning(f"[router] task_id={task_id} unknown capability={capability}")
            return {
                "status": "failed",
                "urls": [],
                "error": f"Unknown capability: {capability}",
                "metadata": {},
            }

        service: BaseCapabilityService = CapabilityRegistry.get(capability)
        # adapter_name 默认与 protocol_name 一致
        effective_adapter = adapter_name or protocol_name
        logger.info(
            f"[router] task_id={task_id} dispatch capability={capability} "
            f"-> {type(service).__name__} protocol={protocol_name} adapter={effective_adapter} model={model}"
        )
        return await service.execute(
            task_id=task_id,
            user_id=user_id,
            prompt=prompt,
            params=params,
            base_url=base_url,
            api_key=api_key,
            protocol_name=protocol_name,
            adapter_name=effective_adapter,
            model=model,
            ref_urls=ref_urls,
            parameter_mapping=parameter_mapping,
            endpoint_mapping=endpoint_mapping,
            override_json=override_json,
        )

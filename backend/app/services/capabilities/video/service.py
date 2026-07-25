"""
VideoService — 视频生成能力服务。

调用链：
  VideoService.execute()
      → AdapterRegistry.get(adapter_name) → adapt_params()
      → apply_parameter_mapping() + apply_override_json()
      → ProtocolRegistry.get(protocol_name, "video") → build_request()
      → TaskManager.submit_and_wait()
"""

from __future__ import annotations

import logging
from typing import Any

from app.config import settings
from app.services.capabilities.base import BaseCapabilityService
from app.services.adapters.base import AdapterRegistry
from app.services.adapters.mapping import (
    apply_parameter_mapping,
    apply_override_json,
    get_endpoint_override,
)
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
        adapter_name: str = "",
        model: str = "",
        ref_urls: list[str] | None = None,
        parameter_mapping: dict | None = None,
        endpoint_mapping: dict | None = None,
        override_json: dict | None = None,
    ) -> dict[str, Any]:
        """执行视频生成。"""
        # 1. 准备基础参数
        body = {
            "model": model,
            "prompt": prompt,
            "ratio": params.get("ratio", "16:9"),
        }

        for key in ("duration", "width", "height", "num_frames", "frame_rate", "fps"):
            if key in params:
                body[key] = params[key]

        if ref_urls:
            body["ref_urls"] = ref_urls

        # 2. Adapter: Provider 参数转换
        body = AdapterRegistry.apply(adapter_name, body, self.capability)

        # 2.5 渠道自定义映射
        body = apply_parameter_mapping(body, parameter_mapping)
        body = apply_override_json(body, override_json)

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
        override_endpoint = get_endpoint_override(endpoint_mapping, "video.generate")
        if override_endpoint:
            endpoint = base_url.rstrip("/") + override_endpoint

        # 4. TaskManager: 提交+轮询
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
            initial_delay=2.0,
        )

        return result


# ── CapabilityRegistry 注册 ─────────────────────────────────

def register():
    """注册 VideoService 到全局能力注册表。"""
    from app.services.capabilities.base import CapabilityRegistry
    CapabilityRegistry.register("video", VideoService())

"""
LLMService — 大语言模型能力服务。

统一走 TaskManager（同步提交），不再直接使用 httpx。
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


class LLMService(BaseCapabilityService):
    """LLM 能力服务。"""

    capability: str = "llm"

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
        """执行 LLM 调用。"""
        # 构造 messages
        messages = params.get("messages")
        if not messages and prompt:
            messages = [{"role": "user", "content": prompt}]
        if not messages:
            return {"status": "failed", "urls": [], "error": "No messages or prompt"}

        body = {
            "model": model,
            "messages": messages,
        }
        for key in ("temperature", "max_tokens", "top_p", "stream", "stop",
                     "frequency_penalty", "presence_penalty"):
            if key in params:
                body[key] = params[key]

        # Adapter
        body = AdapterRegistry.apply(adapter_name, body, self.capability)
        body = apply_parameter_mapping(body, parameter_mapping)
        body = apply_override_json(body, override_json)

        # Protocol
        protocol = ProtocolRegistry.get(protocol_name, self.capability)
        if not protocol:
            return {
                "status": "failed",
                "urls": [],
                "error": f"Protocol '{protocol_name}' does not support LLM",
                "metadata": {},
            }

        endpoint, headers, request_body = protocol.build_request(
            base_url, api_key, body, self.capability
        )

        override_endpoint = get_endpoint_override(endpoint_mapping, "llm.chat")
        if override_endpoint:
            endpoint = base_url.rstrip("/") + override_endpoint

        # 统一走 TaskManager（同步提交）
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
        )

        return result


# ── CapabilityRegistry 注册 ─────────────────────────────────

def register():
    """注册 LLMService 到全局能力注册表。"""
    from app.services.capabilities.base import CapabilityRegistry
    CapabilityRegistry.register("llm", LLMService())

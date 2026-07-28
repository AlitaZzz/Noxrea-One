"""
LLMService — 大语言模型能力服务。

统一走 TaskManager（同步提交），不再直接使用 httpx。
"""

from __future__ import annotations

import logging
from typing import Any

from app.config import settings
from app.schemas.channel_config import ChannelConfig
from app.services.capabilities.base import BaseCapabilityService
from app.services.request_builder import build
from app.logging_config import run_upstream
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
        channel_config: ChannelConfig = ChannelConfig(),
        model: str = "",
        ref_images: list[str] | None = None,
    ) -> dict[str, Any]:
        """执行 LLM 调用。"""
        # 构造 messages（OpenAI 标准格式）
        messages = params.get("messages")
        if not messages and prompt:
            messages = [{"role": "user", "content": prompt}]
        if not messages:
            return {"status": "failed", "urls": [], "error": "No messages or prompt"}

        # messages 中的 image_url（本地 HTTP URL）转为 base64 data URI，
        # 复用 resolve_refs 三档策略：同源读盘 / 白名单安全 fetch / 外链透传
        from app.services.resolvers.reference import resolve_refs
        for msg in messages:
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            urls: list[str] = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url", "")
                    if url and not url.startswith("data:"):
                        urls.append(url)
            if not urls:
                continue
            resolved = await resolve_refs(urls, user_id)
            url_map = dict(zip(urls, resolved))
            for part in content:
                if (isinstance(part, dict)
                        and part.get("type") == "image_url"
                        and isinstance(part.get("image_url"), dict)):
                    orig = part["image_url"].get("url", "")
                    if orig in url_map:
                        part["image_url"]["url"] = url_map[orig]

        body = {
            "model": model,
            "messages": messages,
        }
        for key in ("temperature", "max_tokens", "top_p", "stream", "stop",
                     "frequency_penalty", "presence_penalty"):
            if key in params:
                body[key] = params[key]

        # request_builder 一步完成 body 构造（mapping → transforms → patch）
        body = build(body, channel_config, self.capability, model_name=model, task_id=task_id)

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

        # 渠道自定义端点覆盖
        override = channel_config.get_endpoint_override("llm.chat")
        if override:
            endpoint = base_url.rstrip("/") + override

        # 统一走 TaskManager（同步提交）
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
            ),
        )

        return result


# ── CapabilityRegistry 注册 ─────────────────────────────────

def register():
    """注册 LLMService 到全局能力注册表。"""
    from app.services.capabilities.base import CapabilityRegistry
    CapabilityRegistry.register("llm", LLMService())

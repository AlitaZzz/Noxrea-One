"""
AudioService — 音频能力服务。

支持 TTS（文字转语音）和 STT（语音转文字）。
统一走 TaskManager 提交请求。
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


class AudioService(BaseCapabilityService):
    """音频能力服务。"""

    capability: str = "audio"

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
        """执行音频生成/识别。"""
        mode = params.get("mode", "tts")
        body = {
            "model": model,
            "_audio_mode": mode,
        }

        if mode == "tts":
            body["input"] = prompt or params.get("input", "")
            body["voice"] = params.get("voice", "alloy")
        elif mode == "stt":
            audio = params.get("audio_file") or ""
            if audio:
                body["file"] = audio

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
                "error": f"Protocol '{protocol_name}' does not support audio",
                "metadata": {},
            }

        endpoint, headers, request_body = protocol.build_request(
            base_url, api_key, body, self.capability
        )

        override_endpoint = get_endpoint_override(endpoint_mapping, "audio.speech")
        if override_endpoint:
            endpoint = base_url.rstrip("/") + override_endpoint

        # 统一走 TaskManager
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

        # 处理 TTS 的二进制 bytes 响应
        files = result.pop("files", [])
        if files and not result.get("urls"):
            result["files"] = files  # 保留 files，由 executor 落盘

        return result


# ── CapabilityRegistry 注册 ─────────────────────────────────

def register():
    """注册 AudioService 到全局能力注册表。"""
    from app.services.capabilities.base import CapabilityRegistry
    CapabilityRegistry.register("audio", AudioService())

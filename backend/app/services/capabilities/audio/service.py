"""
AudioService - 音频能力服务。

支持 TTS（文字转语音）和 STT（语音转文字）。
统一走 TaskManager 提交请求。
"""

from __future__ import annotations

import logging

from app.config import settings
from app.schemas.channel_config import ChannelConfig
from app.services.capabilities.base import BaseCapabilityService, CapabilityResult
from app.services.capabilities.requests import AudioRequest
from app.services.request_builder import build
from app.logging_config import run_upstream
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
        channel_config: ChannelConfig = ChannelConfig(),
        model: str = "",
        ref_images: list[str] | None = None,
    ) -> CapabilityResult:
        """执行音频生成/识别。"""
        mode = params.get("mode", "tts")

        req = AudioRequest(
            model=model,
            prompt=prompt,
            mode=mode,
        )
        if mode == "tts":
            req.input = prompt or params.get("input", "")
            req.voice = params.get("voice", "alloy")
        elif mode == "stt":
            req.audio_file = params.get("audio_file") or ""

        internal = req.model_dump(exclude_none=True)
        # STT: provider 期望 "file" 键
        if mode == "stt" and internal.get("audio_file"):
            internal["file"] = internal.pop("audio_file")

        # request_builder 一步完成 body 构造（mapping -> transforms -> patch）
        body = build(internal, channel_config, self.capability, model_name=model, task_id=task_id)

        # Protocol
        protocol = ProtocolRegistry.get(protocol_name, self.capability)
        if not protocol:
            return CapabilityResult.failed(
                f"Protocol '{protocol_name}' does not support audio"
            )

        endpoint, headers, request_body = protocol.build_request(
            base_url, api_key, body, self.capability
        )

        # 渠道自定义端点覆盖
        override = channel_config.get_endpoint_override("audio.speech")
        if override:
            endpoint = base_url.rstrip("/") + override

        # 统一走 TaskManager
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

        # 处理 TTS 的二进制 bytes 响应
        result_obj = CapabilityResult.from_dict(result)
        if result_obj.files and not result_obj.urls:
            pass  # files 已在 result_obj 中，由 executor 落盘
        else:
            result_obj.files = []  # 有 urls 时清空 files

        return result_obj


# ── CapabilityRegistry 注册 ─────────────────────────────────

def register():
    """注册 AudioService 到全局能力注册表。"""
    from app.services.capabilities.base import CapabilityRegistry
    CapabilityRegistry.register("audio", AudioService())

"""
OpenAIAudioProtocol — OpenAI 兼容音频协议。

支持：
- /v1/audio/speech（TTS）
- /v1/audio/transcriptions（STT）
"""

from __future__ import annotations

from app.schemas.result import GenerationResult, PollResult
from app.services.protocols.openai.base import OpenAIBaseProtocol


class OpenAIAudioProtocol(OpenAIBaseProtocol):
    """OpenAI 兼容音频协议。"""

    protocol_name: str = "openai"

    def build_request(
        self,
        base_url: str,
        api_key: str,
        body: dict,
        capability: str = "audio",
    ) -> tuple[str, dict, dict]:
        mode = body.get("_audio_mode", "tts")  # "tts" / "stt"
        if mode == "stt":
            endpoint = self.build_endpoint(base_url, "/audio/transcriptions")
        else:
            endpoint = self.build_endpoint(base_url, "/audio/speech")
        return endpoint, self._build_headers(api_key), body

    def extract_result(self, data: dict, capability: str = "audio") -> GenerationResult | None:
        """提取音频结果。

        TTS: 响应为二进制 bytes（TaskManager 直接处理）
        STT: {text: "..."}
        """
        text = data.get("text") or ""
        if text:
            return GenerationResult(
                urls=[],
                metadata={"text": text},
                mime_type="text/plain",
            )
        # TTS 模式：响应为音频 bytes，由 TaskManager submit_and_wait 处理
        urls = []
        for item in data.get("data") or []:
            if isinstance(item, dict) and item.get("url"):
                urls.append(item["url"])
        if urls:
            return GenerationResult(urls=urls, mime_type="audio/mpeg")
        return None

    def supports(self, capability: str) -> bool:
        return capability == "audio"

    def build_poll_url(self, base_url: str, upstream_task_id: str) -> str:
        return self.build_endpoint(base_url, f"/tasks/{upstream_task_id}")

    def parse_poll_response(self, data: dict, capability: str = "audio") -> PollResult:
        payload = self._unwrap(data)
        if not isinstance(payload, dict):
            return PollResult(status="pending")
        result = self.extract_result(payload, capability)
        if result:
            return PollResult(status="completed", urls=result.urls, metadata=result.metadata)
        status = self.normalize_status(payload.get("status", "") or "")
        if status == "failed":
            err = payload.get("error") or payload.get("message") or "Unknown"
            return PollResult(status="failed", error=str(err))
        return PollResult(status="pending")

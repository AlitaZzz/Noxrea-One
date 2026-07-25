"""
GeminiImageProtocol — Gemini 原生图片生成协议（暂未实现）。

TODO: 保持 Gemini 原生格式（contents/parts/candidates）。
"""

from __future__ import annotations

from app.schemas.result import GenerationResult, PollResult
from app.services.protocols.gemini.base import GeminiBaseProtocol


class GeminiImageProtocol(GeminiBaseProtocol):
    """Gemini 图片生成协议（占位）。"""

    protocol_name: str = "gemini"

    def build_request(
        self,
        base_url: str,
        api_key: str,
        body: dict,
        capability: str = "image",
    ) -> tuple[str, dict, dict]:
        raise NotImplementedError("Gemini 图片生成协议暂未实现")

    def extract_result(self, data: dict, capability: str = "image") -> GenerationResult | None:
        raise NotImplementedError("Gemini 图片生成协议暂未实现")

    def supports(self, capability: str) -> bool:
        return capability == "image"

    def extract_task_id(self, data: dict) -> str | None:
        raise NotImplementedError("Gemini 图片生成协议暂未实现")

    def build_poll_url(self, base_url: str, upstream_task_id: str) -> str:
        raise NotImplementedError("Gemini 图片生成协议暂未实现")

    def parse_poll_response(self, data: dict, capability: str = "image") -> PollResult:
        raise NotImplementedError("Gemini 图片生成协议暂未实现")

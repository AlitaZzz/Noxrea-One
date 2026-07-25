"""
GeminiLLMProtocol — Gemini 原生 LLM 协议（暂未实现）。

TODO: 保持 Gemini 原生格式（contents/parts/candidates），不强行转 OpenAI。
"""

from __future__ import annotations

from app.schemas.result import GenerationResult, PollResult
from app.services.protocols.gemini.base import GeminiBaseProtocol


class GeminiLLMProtocol(GeminiBaseProtocol):
    """Gemini LLM 协议（占位）。"""

    protocol_name: str = "gemini"

    def build_request(
        self,
        base_url: str,
        api_key: str,
        body: dict,
        capability: str = "llm",
    ) -> tuple[str, dict, dict]:
        raise NotImplementedError("Gemini LLM 协议暂未实现")

    def extract_result(self, data: dict, capability: str = "llm") -> GenerationResult | None:
        raise NotImplementedError("Gemini LLM 协议暂未实现")

    def supports(self, capability: str) -> bool:
        return capability == "llm"

    def extract_task_id(self, data: dict) -> str | None:
        raise NotImplementedError("Gemini LLM 协议暂未实现")

    def build_poll_url(self, base_url: str, upstream_task_id: str) -> str:
        raise NotImplementedError("Gemini LLM 协议暂未实现")

    def parse_poll_response(self, data: dict, capability: str = "llm") -> PollResult:
        raise NotImplementedError("Gemini LLM 协议暂未实现")

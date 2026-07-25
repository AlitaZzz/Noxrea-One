"""
OpenAILLMProtocol — OpenAI 兼容 LLM 协议。

支持 /v1/chat/completions，普通和 streaming 两种模式。
"""

from __future__ import annotations

from app.schemas.result import GenerationResult, PollResult
from app.services.protocols.openai.base import OpenAIBaseProtocol


class OpenAILLMProtocol(OpenAIBaseProtocol):
    """OpenAI 兼容 LLM 协议。"""

    protocol_name: str = "openai"

    def build_request(
        self,
        base_url: str,
        api_key: str,
        body: dict,
        capability: str = "llm",
    ) -> tuple[str, dict, dict]:
        endpoint = OpenAIBaseProtocol.build_endpoint(base_url, "/chat/completions")
        return endpoint, self._build_headers(api_key), body

    def extract_result(self, data: dict, capability: str = "llm") -> GenerationResult | None:
        """从 chat completion 响应提取文本结果。"""
        messages = data.get("choices") or []
        if not messages:
            return None

        # 提取所有 choice 的 message content
        texts = []
        for choice in messages:
            msg = choice.get("message") or {}
            content = msg.get("content") or ""
            if content:
                texts.append(content)

        meta = {
            "model": data.get("model", ""),
            "usage": data.get("usage", {}),
            "finish_reason": messages[0].get("finish_reason", ""),
        }

        return GenerationResult(
            urls=[],
            metadata={"text": "\n".join(texts), **meta},
            mime_type="text/plain",
        )

    def supports(self, capability: str) -> bool:
        return capability == "llm"

    def build_poll_url(self, base_url: str, upstream_task_id: str) -> str:
        return self.build_endpoint(base_url, f"/tasks/{upstream_task_id}")

    def parse_poll_response(self, data: dict, capability: str = "llm") -> PollResult:
        payload = self._unwrap(data)
        if not isinstance(payload, dict):
            return PollResult(status="pending")
        result = self.extract_result(payload, capability)
        if result:
            return PollResult(status="completed", metadata=result.metadata)
        return PollResult(status="pending")

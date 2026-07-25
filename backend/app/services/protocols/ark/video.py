"""
ArkVideoProtocol — 火山方舟视频生成协议（暂未实现）。

TODO: POST /api/v3/contents/generations 提交，GET /api/v3/contents/generations/tasks/{id} 轮询。
"""

from __future__ import annotations

from app.schemas.result import GenerationResult, PollResult
from app.services.protocols.ark.base import ArkBaseProtocol


class ArkVideoProtocol(ArkBaseProtocol):
    """Ark 视频生成协议（占位）。"""

    protocol_name: str = "ark"

    def build_request(
        self,
        base_url: str,
        api_key: str,
        body: dict,
        capability: str = "video",
    ) -> tuple[str, dict, dict]:
        raise NotImplementedError("Ark 视频生成协议暂未实现")

    def extract_result(self, data: dict, capability: str = "video") -> GenerationResult | None:
        raise NotImplementedError("Ark 视频生成协议暂未实现")

    def supports(self, capability: str) -> bool:
        return capability == "video"

    def extract_task_id(self, data: dict) -> str | None:
        raise NotImplementedError("Ark 视频生成协议暂未实现")

    def build_poll_url(self, base_url: str, upstream_task_id: str) -> str:
        raise NotImplementedError("Ark 视频生成协议暂未实现")

    def parse_poll_response(self, data: dict, capability: str = "video") -> PollResult:
        raise NotImplementedError("Ark 视频生成协议暂未实现")

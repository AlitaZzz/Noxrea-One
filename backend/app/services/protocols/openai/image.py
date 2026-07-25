"""
OpenAIImageProtocol — OpenAI 兼容图片生成协议。

支持 /v1/images/generations 端点，解析 data[].url 和 data[].b64_json。
"""

from __future__ import annotations

from app.schemas.result import GenerationResult, PollResult
from app.services.protocols.openai.base import OpenAIBaseProtocol


class OpenAIImageProtocol(OpenAIBaseProtocol):
    """OpenAI 兼容图片生成协议。"""

    protocol_name: str = "openai"

    def build_request(
        self,
        base_url: str,
        api_key: str,
        body: dict,
        capability: str = "image",
    ) -> tuple[str, dict, dict]:
        endpoint = OpenAIBaseProtocol.build_endpoint(base_url, "/images/generations")
        return endpoint, self._build_headers(api_key), body

    def extract_result(self, data: dict, capability: str = "image") -> GenerationResult | None:
        return self._extract_image_result(data)

    def supports(self, capability: str) -> bool:
        return capability == "image"

    def build_poll_url(self, base_url: str, upstream_task_id: str) -> str:
        return self.build_endpoint(base_url, f"/tasks/{upstream_task_id}")

    def parse_poll_response(self, data: dict, capability: str = "image") -> PollResult:
        """OpenAI 兼容异步图片轮询解析。"""
        payload = self._unwrap(data)
        if not isinstance(payload, dict):
            return PollResult(status="pending")
        status = self.normalize_status(payload.get("status", "") or "")
        if status == "completed":
            result = self._extract_image_result(payload)
            if result:
                return PollResult(status="completed", urls=result.urls, files=result.files)
            # 确认状态为 completed 但无 data → 查看 output 等兜底字段
            output_urls = payload.get("output") or payload.get("result")
            if isinstance(output_urls, str):
                return PollResult(status="completed", urls=[output_urls])
        if status == "failed":
            err = payload.get("error") or payload.get("message") or "Unknown error"
            if isinstance(err, dict):
                err = err.get("message", "Unknown error")
            return PollResult(status="failed", error=str(err))

        # status-agnostic 兜底：无论 status 是否缺失/嵌套/非标准，
        # 只要能提取到图片数据就视为完成。
        result = self._extract_image_result(payload)
        if not result and isinstance(payload, dict):
            # 尝试双重包裹：{code:{data:{data:{actual_data}}}}
            result = self._extract_image_result(payload.get("data") or {})
        if result:
            return PollResult(status="completed", urls=result.urls, files=result.files)

        return PollResult(status="pending")

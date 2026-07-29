"""
OpenAIVideoProtocol — OpenAI 兼容视频生成协议。

OpenAI Sora 类视频生成 API：提交生成请求，轮询获取结果。
"""

from __future__ import annotations

from app.schemas.result import GenerationResult, PollResult
from app.services.protocols.openai.base import OpenAIBaseProtocol


class OpenAIVideoProtocol(OpenAIBaseProtocol):
    """OpenAI 兼容视频生成协议。"""

    protocol_name: str = "openai"

    def build_request(
        self,
        base_url: str,
        api_key: str,
        body: dict,
        capability: str = "video",
    ) -> tuple[str, dict, dict]:
        endpoint = OpenAIBaseProtocol.build_endpoint(base_url, "/videos")
        return endpoint, self._build_headers(api_key), body

    def extract_result(self, data: dict, capability: str = "video") -> GenerationResult | None:
        # 视频基本为异步，返回 None 走轮询
        return None

    def supports(self, capability: str) -> bool:
        return capability == "video"

    def extract_task_id(self, data: dict) -> str | None:
        """从视频提交响应提取 task_id。支持 id / task_id / video_id。"""
        return data.get("id") or data.get("task_id") or data.get("video_id")

    def build_poll_url(self, base_url: str, upstream_task_id: str) -> str:
        return self.build_endpoint(base_url, f"/videos/{upstream_task_id}")

    def parse_poll_response(self, data: dict, capability: str = "video") -> PollResult:
        """解析视频轮询响应。

        支持多种上游视频状态格式：
        - status/completed → completed
        - video_url/url/output → 视频 URL
        - failed/error → failed
        """
        payload = self._unwrap(data)
        if not isinstance(payload, dict):
            return PollResult(status="pending")

        state = str(payload.get("status") or payload.get("state") or "").lower()
        norm = self.normalize_status(state)

        if norm == "completed":
            url = (
                payload.get("video_url")
                or payload.get("url")
                or payload.get("output")
            )
            # 尝试从 metadata 中提取（如 agnes-video 返回 metadata.url）
            if not url:
                meta = payload.get("metadata")
                if isinstance(meta, dict):
                    url = meta.get("url") or meta.get("video_url") or meta.get("output")
            if url:
                duration = payload.get("duration") or payload.get("duration_seconds")
                meta = {"mime_type": "video/mp4"}
                if duration:
                    meta["duration"] = duration
                # 保留上游 metadata 中的额外信息
                upstream_meta = payload.get("metadata")
                if isinstance(upstream_meta, dict):
                    if "duration" not in meta and upstream_meta.get("duration"):
                        meta["duration"] = upstream_meta["duration"]
                    if upstream_meta.get("size"):
                        meta["size"] = upstream_meta["size"]
                return PollResult(status="completed", urls=[url], metadata=meta)
            # 也尝试从 data[] 中提取
            items = payload.get("data") or payload.get("results") or []
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict):
                        u = item.get("video_url") or item.get("url")
                        if u:
                            meta = {"mime_type": "video/mp4"}
                            if item.get("duration"):
                                meta["duration"] = item["duration"]
                            return PollResult(status="completed", urls=[u], metadata=meta)
            return PollResult(status="pending")

        if norm == "failed":
            err = payload.get("error") or payload.get("message") or "Unknown video error"
            if isinstance(err, dict):
                err = err.get("message", "Unknown video error")
            return PollResult(status="failed", error=str(err))

        return PollResult(status="pending")

from typing import Any, Optional, Union

from .base import ProviderConfig, base64
from app.config import settings

# ── APIMart ─────────────────────────────────────────────────────
# 异步提交->轮询协议：
#   1. POST /images/generations -> {code, data: [{"status":"submitted", "task_id":...}]}
#   2. GET  /v1/tasks/{task_id}  -> {code, data: {status, result:{images:[{url:[...]}]}}}
# size = 比例（1:1），resolution = 档位（2k），official_fallback = false
# 轮询参数走 settings.WORKER_ASYNC_POLL_*（可在 .env 调）


class ApimartProvider(ProviderConfig):
    def __init__(self):
        super().__init__(
            "apimart",
            "/images/generations",
            "",
            poll_interval=int(settings.WORKER_ASYNC_POLL_INTERVAL * 1000),   # ms
            max_poll_attempts=settings.WORKER_ASYNC_POLL_MAX_ATTEMPTS,
            presets=[{"name": "APIMart", "baseUrl": "https://api.apimart.ai/v1"}],
        )

    def build_image_body(
        self,
        model: str,
        prompt: str,
        n: int,
        ratio: str,
        size: str,
        quality: str = "auto",
        refs: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": 1,
            "size": ratio,                          # 比例，如 "1:1"
            "resolution": (size or "1K").lower(),   # 档位，如 "2k"
            "official_fallback": False,
        }
        if refs:
            body["image_urls"] = refs               # 参考图 data URL 数组
        return body

    def _unwrap(self, data: Any) -> Union[dict, list, None]:
        """解掉 APIMart 的 {code, data} 外层。data 可能是 dict 或 list。"""
        if isinstance(data, dict):
            inner = data.get("data")
            return inner if isinstance(inner, (dict, list)) else data
        return data if isinstance(data, (dict, list)) else None

    def _first_url(self, url_value: Any) -> Optional[str]:
        """url 字段可能是字符串或数组，统一取第一个有效值。"""
        if isinstance(url_value, list):
            for u in url_value:
                if isinstance(u, str) and u:
                    return u
            return None
        if isinstance(url_value, str) and url_value:
            return url_value
        return None

    def extract_image(self, data: dict[str, Any]) -> tuple[Optional[str], Optional[bytes]]:
        """同步兜底：极少情况下 APIMart 直接返回图片。返回 (None,None) 触发异步轮询。"""
        payload = self._unwrap(data)
        items = []
        if isinstance(payload, list):
            items = payload
        elif isinstance(payload, dict):
            items = payload.get("data") or []
        for item in items:
            if not isinstance(item, dict):
                continue
            url = self._first_url(item.get("url"))
            if url:
                return url, None
            b64 = item.get("b64_json")
            if b64:
                return None, base64.b64decode(b64)
        return None, None

    def extract_image_task_id(self, data: dict[str, Any]) -> Optional[str]:
        payload = self._unwrap(data)
        # 提交响应：data 是 [{"status":"submitted", "task_id":"..."}]
        if isinstance(payload, list) and payload:
            return payload[0].get("task_id") if isinstance(payload[0], dict) else None
        if isinstance(payload, dict):
            return payload.get("task_id")
        return None

    def build_image_poll_url(self, base_url: str, task_id: str) -> str:
        # baseUrl = https://api.apimart.ai/v1 -> /v1/tasks/{id}
        return f"{base_url}/tasks/{task_id}"

    def extract_image_poll_result(self, data: dict[str, Any]) -> Optional[str]:
        payload = self._unwrap(data)
        if not isinstance(payload, dict):
            return None
        # 上游直接返回 {error:{...}}（如无效任务ID、鉴权失败）-> 立即判定失败，不要当 pending 轮询
        if isinstance(data, dict) and isinstance(data.get("error"), dict):
            return "__FAILED__"
        status = str(payload.get("status") or payload.get("task_status") or "").upper()
        if status in {"SUCCESS", "SUCCEEDED", "SUCCEED", "COMPLETED"}:
            # 首选路径：result.images[].url[]（url 可能是数组或字符串）
            result = payload.get("result") or {}
            if isinstance(result, dict):
                for img in (result.get("images") or []):
                    if isinstance(img, dict):
                        url = self._first_url(img.get("url"))
                        if url:
                            return url
            # 兜底：其他常见结构（output_images / images / output / data[]）
            for key in ("output_images", "images", "output", "data"):
                items = payload.get(key)
                if isinstance(items, list) and items:
                    first = items[0]
                    if isinstance(first, dict):
                        url = self._first_url(first.get("url"))
                        if url:
                            return url
                    elif isinstance(first, str) and first:
                        return first
        if status in {"FAILED", "FAIL", "ERROR", "TIMEOUT"}:
            return "__FAILED__"
        return None  # still pending

    def extract_image_poll_error(self, data: dict[str, Any]) -> Optional[str]:
        """从轮询响应提取失败原因，供 worker 记录日志。"""
        # 外层 {error:{message:...}}（如无效任务ID）
        if isinstance(data, dict) and isinstance(data.get("error"), dict):
            return data["error"].get("message") or data["error"].get("code")
        payload = self._unwrap(data)
        if isinstance(payload, dict):
            # data.status=failed + error/message 字段
            err = payload.get("error")
            if isinstance(err, dict):
                return err.get("message") or err.get("code")
            if payload.get("message"):
                return str(payload["message"])
            if payload.get("fail_reason"):
                return str(payload["fail_reason"])
        return None
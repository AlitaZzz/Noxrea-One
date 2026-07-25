"""
OpenAIBaseProtocol — OpenAI 协议族共享帮助方法。

各子类（image / llm / audio）继承此基类获得：
- 通用的 build_endpoint
- 标准的 Authorization header
- 通用的 extract_result 逻辑（遍历 data[]）
"""

from __future__ import annotations

import base64

from app.services.protocols.base import BaseProtocol
from app.schemas.result import GenerationResult


class OpenAIBaseProtocol(BaseProtocol):
    """OpenAI 协议族基类。"""

    protocol_name: str = "openai"

    @staticmethod
    def _build_headers(api_key: str) -> dict:
        h = {"Content-Type": "application/json"}
        if api_key:
            h["Authorization"] = f"Bearer {api_key}"
        return h

    @staticmethod
    def _extract_image_result(data: dict) -> GenerationResult | None:
        """OpenAI 通用图片结果提取：遍历 data[] 收集 url 和 b64_json。

        b64 优先：同一 item 同时有 url 和 b64_json 时只取 b64，免去二次 HTTP 下载。
        """
        b64_bytes: list[bytes] = []
        urls: list[str] = []
        items = data.get("data") or []
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                b = item.get("b64_json")
                if b:
                    b64_bytes.append(base64.b64decode(b))
                    continue  # b64 优先，跳过 url
                u = item.get("url")
                if u:
                    urls.append(u)
        # 兜底：代理格式 {"result": {"images": [{"url": ["https://..."]}]}}
        if not urls and not b64_bytes:
            result = data.get("result") or {}
            if isinstance(result, dict):
                for img in result.get("images") or []:
                    if isinstance(img, dict):
                        url_val = img.get("url")
                        if isinstance(url_val, list):
                            urls.extend(u for u in url_val if isinstance(u, str))
                        elif isinstance(url_val, str):
                            urls.append(url_val)
        if b64_bytes or urls:
            return GenerationResult(urls=urls, files=b64_bytes, mime_type="image/png")
        return None

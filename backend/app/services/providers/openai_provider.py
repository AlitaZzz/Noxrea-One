from typing import Any

from .base import ProviderConfig, _resolve_size

# ── OpenAI ──────────────────────────────────────────────────────


class OpenAIProvider(ProviderConfig):
    def __init__(self):
        super().__init__("api.openai.com", "/images/generations", "")

    def build_image_body(self, model, prompt, n, ratio, size, quality="auto", refs=None):
        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "size": _resolve_size(None, ratio, size),
            # "response_format": "url",  # 去掉这个参数,让 API 用默认格式(很多 API 不支持 url 只返回 base64)
        }
        if quality and quality != "auto":
            body["quality"] = quality
        if refs:
            body["image_urls"] = refs
        return body

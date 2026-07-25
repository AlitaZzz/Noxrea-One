"""
OpenAIAdapter — OpenAI 兼容 API 参数适配。

职责：
- size_level + ratio → 像素 size（如 size_level="1K", ratio="16:9" → "1536x864"）
- ref_urls → image（OpenAI 标准字段名）
- quality / n 透传
"""

from __future__ import annotations

from app.services.adapters.base import BaseAdapter
from app.services.adapters.common import resolve_image_size


class OpenAIAdapter(BaseAdapter):
    """OpenAI 兼容 API 参数适配器。"""

    name: str = "openai"

    def adapt_params(self, params: dict, capability: str = "image") -> dict:
        # 拷贝避免修改入参
        out = dict(params)

        if capability == "image":
            return self._adapt_image(out)
        elif capability == "video":
            return self._adapt_video(out)
        elif capability == "llm":
            return out  # LLM 参数透传
        elif capability == "audio":
            return out  # Audio 参数透传
        return out

    def _adapt_image(self, out: dict) -> dict:
        # size_level + ratio → 像素 size
        level = out.pop("size_level", None)
        if level:
            out["size"] = resolve_image_size(level, out.get("ratio", "1:1"))

        # ref_urls → image（OpenAI 标准字段）
        refs = out.pop("ref_urls", None)
        if refs:
            out["image"] = refs

        return out

    def _adapt_video(self, out: dict) -> dict:
        # ref_urls → image
        refs = out.pop("ref_urls", None)
        if refs:
            out["image"] = refs
        return out

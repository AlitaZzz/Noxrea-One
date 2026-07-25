"""
GeminiAdapter — Gemini 原生 API 参数适配（暂未实现）。

TODO: size_level + ratio → 像素 size；ref_urls → reference_images（Gemini 字段名）。
"""

from __future__ import annotations

from app.services.adapters.base import BaseAdapter


class GeminiAdapter(BaseAdapter):
    """Gemini 原生 API 参数适配器（占位）。"""

    name: str = "gemini"

    def adapt_params(self, params: dict, capability: str = "image") -> dict:
        raise NotImplementedError("Gemini 适配器暂未实现")

"""
ArkAdapter — 火山方舟 / Ark 兼容 API 参数适配（暂未实现）。

TODO: size_level + ratio → Ark 像素 size；ref_urls → Ark 格式参考图；视频参数标准化。
"""

from __future__ import annotations

from app.services.adapters.base import BaseAdapter


class ArkAdapter(BaseAdapter):
    """火山方舟 / Ark 兼容 API 参数适配器（占位）。"""

    name: str = "ark"

    def adapt_params(self, params: dict, capability: str = "image") -> dict:
        raise NotImplementedError("Ark 适配器暂未实现")

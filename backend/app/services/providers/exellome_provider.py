from typing import Any

from .base import ProviderConfig

# ── exellome.online ─────────────────────────────────────────────
# OpenAI 兼容，但 size 用比例(1:1)、resolution 用档位(1k/2k/4k)；
# 文生图走 /images/generations，图生图走 /images/edits + image 数组。


class ExellomeProvider(ProviderConfig):
    def __init__(self):
        super().__init__(
            "exellome",
            "/images/generations",
            "",
            image_edit_endpoint="/images/edits",
        )

    def build_image_body(self, model, prompt, n, ratio, size, quality="auto", refs=None):
        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "size": ratio,                          # exellome 的 size = 比例
            "resolution": (size or "1K").lower(),   # 1K -> 1k
        }
        if quality and quality != "auto":
            body["quality"] = quality
        if refs:
            body["image"] = refs                    # 图生图：image 数组
        return body

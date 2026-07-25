"""
Adapter 公共工具——图片尺寸档位 → 像素解析。

属于 Provider 层逻辑（厂商期望像素 size），因此放在 adapters 包内，
由需要像素尺寸的 Adapter（OpenAI / Gemini 系）调用。
CapabilityService 不得调用本函数（那是 Provider 参数，违反分层）。
"""

from __future__ import annotations

# 统一尺寸档位 → 像素，通用映射（OpenAI / Gemini 等以像素 size 为准）
GENERIC_SIZES = {
    "1:1": "1024x1024",
    "1:2": "1024x2048",
    "2:1": "2048x1024",
    "3:2": "1280x853",
    "2:3": "853x1280",
    "3:4": "896x1152",
    "4:3": "1152x896",
    "16:9": "1536x864",
    "9:16": "864x1536",
}

# 档位 → 缩放倍率
SIZE_FACTOR = {"1k": 1, "2k": 2, "4k": 4}


def resolve_image_size(size_level: str, ratio: str = "1:1") -> str:
    """将业务尺寸档位 + 比例转换为厂商像素尺寸字符串。

    size_level 支持 "1K" / "2K" / "4K"，逐级放大通用尺寸。
    CapabilityService 只持有 size_level（业务档位），本函数由 Adapter 调用，
    确保"像素/分辨率"等 Provider 概念不向上泄漏。
    """
    level = (size_level or "1k").lower()
    base = GENERIC_SIZES.get(ratio, "1024x1024")
    w, h = base.split("x")
    factor = SIZE_FACTOR.get(level, 1)
    return f"{int(w) * factor}x{int(h) * factor}"

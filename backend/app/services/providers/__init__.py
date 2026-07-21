"""
Provider 注册表。

具体 provider 在同目录 *_provider.py；基类与共享工具在 base.py。
worker.py 通过 `from app.services.providers import detect_provider, ...` 访问，
本模块再导出以保持旧 import 不破。
"""

from .base import ProviderConfig, build_endpoint, download_and_save, is_async_provider
from .openai_provider import OpenAIProvider
from .exellome_provider import ExellomeProvider
from .agnes_provider import AgnesProvider
from .nanobanana_provider import NanoBananaProvider
from .gpt_image_provider import GPTImageProvider

# ── Registry ────────────────────────────────────────────────────

PROVIDERS: list[ProviderConfig] = [
    OpenAIProvider(),
    ExellomeProvider(),
    AgnesProvider(),
    NanoBananaProvider(),
    GPTImageProvider(),
]


def detect_provider(base_url: str) -> ProviderConfig:
    for p in PROVIDERS:
        if p.matches(base_url):
            return p
    return PROVIDERS[0]  # fallback to OpenAI


__all__ = [
    "ProviderConfig",
    "build_endpoint",
    "download_and_save",
    "is_async_provider",
    "detect_provider",
    "PROVIDERS",
    "OpenAIProvider",
    "ExellomeProvider",
    "AgnesProvider",
    "NanoBananaProvider",
    "GPTImageProvider",
]

"""
Provider 基类与共享工具。

各具体 provider 见同目录 *_provider.py；注册表与 detect_provider 在 __init__.py。
"""

import base64
import logging
from typing import Any, Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# ── Size resolution ─────────────────────────────────────────────

SIZE_INDEX: dict[str, int] = {"1K": 0, "2K": 1, "4K": 2}
GENERIC_SIZES = ["1024x1024", "2048x2048", "4096x4096"]


def _resolve_size(sizes_by_ratio: dict[str, list[str]] | None, ratio: str, size_level: str) -> str:
    idx = SIZE_INDEX.get(size_level, 0)
    if sizes_by_ratio:
        return (sizes_by_ratio.get(ratio) or GENERIC_SIZES)[idx]
    return GENERIC_SIZES[idx]


def build_endpoint(api_base: str, suffix: str) -> str:
    """拼接 base_url 与 endpoint，去掉重复的 /v1 段。"""
    base = api_base.rstrip("/")
    if base.endswith("/v1") and suffix.startswith("/v1"):
        suffix = suffix[len("/v1"):]
    return base + suffix


# ── Provider type ────────────────────────────────────────────────


class ProviderConfig:
    def __init__(
        self,
        detect: str,
        image_endpoint: str = "",
        video_endpoint: str = "",
        sizes_by_ratio: dict[str, list[str]] | None = None,
        generic_sizes: list[str] | None = None,
        poll_interval: int = 5000,
        max_poll_attempts: int = 0,
        image_edit_endpoint: str = "",
    ):
        self.detect_str = detect
        self.image_endpoint = image_endpoint
        self.video_endpoint = video_endpoint
        self.sizes_by_ratio = sizes_by_ratio
        self.generic_sizes = generic_sizes or GENERIC_SIZES
        self.poll_interval = poll_interval
        self.max_poll_attempts = max_poll_attempts
        # 有参考图（图生图/编辑）时改走这个端点；空则复用 image_endpoint
        self.image_edit_endpoint = image_edit_endpoint

    def matches(self, base_url: str) -> bool:
        return self.detect_str in base_url.lower()

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
        raise NotImplementedError

    def build_video_body(self, model: str, prompt: str, ratio: str, refs: Optional[list[str]] = None) -> dict[str, Any]:
        raise NotImplementedError

    def extract_image(self, data: dict[str, Any]) -> tuple[Optional[str], Optional[bytes]]:
        """从响应抽取结果，返回 (url, raw_bytes)：优先 url，其次 b64_json。"""
        for item in (data.get("data") or []):
            if item.get("url"):
                return item["url"], None
            b64 = item.get("b64_json")
            if b64:
                return None, base64.b64decode(b64)
        return None, None

    def extract_video_id(self, data: dict[str, Any]) -> Optional[str]:
        return None

    def build_poll_url(self, base_url: str, video_id: str) -> str:
        return ""

    def extract_video_result(self, data: dict[str, Any]) -> Optional[str]:
        return None


def is_async_provider(provider: ProviderConfig) -> bool:
    return provider.max_poll_attempts > 0


# ── Download & save (used by worker) ────────────────────────────


async def download_and_save(cdn_url: str, auth_header: str, user_jwt: str, file_type: str) -> str:
    """Download from CDN and save to local storage. Returns local URL."""
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            # Try without auth first
            resp = await client.get(cdn_url, follow_redirects=True)
            if resp.status_code == 401 and auth_header:
                resp = await client.get(cdn_url, headers={"Authorization": auth_header}, follow_redirects=True)
            if not resp.is_success:
                return cdn_url

            ext = "mp4" if file_type == "video" else "png"
            files = {"file": (f"generated.{ext}", resp.content)}
            headers = {"Authorization": f"Bearer {user_jwt}"} if user_jwt else {}
            save_resp = await client.post(
                f"{settings.PUBLIC_URL}/api/files/upload?category=generated",
                files=files,
                headers=headers,
            )
            if save_resp.is_success:
                data = save_resp.json()
                if data.get("data", {}).get("url"):
                    return data["data"]["url"]
    except Exception as e:
        logger.warning(f"download_and_save failed url={cdn_url[:60]} err={str(e)[:120]}")
    return cdn_url

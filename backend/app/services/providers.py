"""
Provider configuration — Python port of frontend/src/app/api/providers.ts

Each provider defines how to detect it, build request bodies, and extract results.
"""

import uuid
from typing import Any, Optional

import httpx

from app.config import settings

# ── Size resolution ─────────────────────────────────────────────

AGNES_SIZES: dict[str, list[str]] = {
    "1:1":  ["1024x1024", "2048x2048", "4096x4096"],
    "3:4":  ["864x1152", "1728x2304", "3456x4608"],
    "4:3":  ["1152x864", "2304x1728", "4608x3456"],
    "16:9": ["1312x736", "2624x1472", "5248x2944"],
    "9:16": ["736x1312", "1472x2624", "2944x5248"],
    "2:3":  ["832x1248", "1664x2496", "3328x4992"],
    "3:2":  ["1248x832", "2496x1664", "4992x3328"],
    "21:9": ["1568x672", "3136x1344", "6272x2688"],
    "1:2":  ["704x1408", "1408x2816", "2816x5632"],
    "2:1":  ["1408x704", "2816x1408", "5632x2816"],
    "5:4":  ["1120x896", "2240x1792", "4480x3584"],
    "4:5":  ["896x1120", "1792x2240", "3584x4480"],
    "9:21": ["672x1568", "1296x3024", "2592x6048"],
}

SIZE_INDEX: dict[str, int] = {"1K": 0, "2K": 1, "4K": 2}
GENERIC_SIZES = ["1024x1024", "2048x2048", "4096x4096"]


def _resolve_size(sizes_by_ratio: dict[str, list[str]] | None, ratio: str, size_level: str) -> str:
    idx = SIZE_INDEX.get(size_level, 0)
    if sizes_by_ratio:
        return (sizes_by_ratio.get(ratio) or GENERIC_SIZES)[idx]
    return GENERIC_SIZES[idx]


VIDEO_DIMS: dict[str, dict[str, int]] = {
    "1:1": {"width": 1024, "height": 1024},
    "3:4": {"width": 864, "height": 1152},
    "4:3": {"width": 1152, "height": 864},
    "16:9": {"width": 1312, "height": 736},
    "9:16": {"width": 736, "height": 1312},
    "2:3": {"width": 832, "height": 1248},
    "3:2": {"width": 1248, "height": 832},
    "21:9": {"width": 1568, "height": 672},
}


def _get_video_dims(ratio: str) -> dict[str, int]:
    return VIDEO_DIMS.get(ratio, {"width": 1312, "height": 736})


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
    ):
        self.detect_str = detect
        self.image_endpoint = image_endpoint
        self.video_endpoint = video_endpoint
        self.sizes_by_ratio = sizes_by_ratio
        self.generic_sizes = generic_sizes or GENERIC_SIZES
        self.poll_interval = poll_interval
        self.max_poll_attempts = max_poll_attempts

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

    def extract_image_url(self, data: dict[str, Any]) -> Optional[str]:
        return None

    def extract_video_id(self, data: dict[str, Any]) -> Optional[str]:
        return None

    def build_poll_url(self, base_url: str, video_id: str) -> str:
        return ""

    def extract_video_result(self, data: dict[str, Any]) -> Optional[str]:
        return None


# ── OpenAI ──────────────────────────────────────────────────────


class OpenAIProvider(ProviderConfig):
    def __init__(self):
        super().__init__("api.openai.com", "/v1/images/generations", "")

    def build_image_body(self, model, prompt, n, ratio, size, quality="auto", refs=None):
        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "size": _resolve_size(None, ratio, size),
            "response_format": "url",
        }
        if quality and quality != "auto":
            body["quality"] = quality
        if refs:
            body["image"] = refs
        return body

    def extract_image_url(self, data):
        return (data.get("data") or [None])[0].get("url") if data.get("data") else None


# ── Agnes AI ────────────────────────────────────────────────────


class AgnesProvider(ProviderConfig):
    def __init__(self):
        super().__init__(
            "agnes",
            "/images/generations",
            "/videos",
            sizes_by_ratio=AGNES_SIZES,
            poll_interval=5000,
            max_poll_attempts=72,
        )

    def build_image_body(self, model, prompt, n, ratio, size, quality="auto", refs=None):
        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "size": _resolve_size(self.sizes_by_ratio, ratio, size),
            "ratio": ratio,
            "extra_body": {"response_format": "url"},
        }
        if quality and quality != "auto":
            body["quality"] = quality
        if refs:
            body["extra_body"]["image"] = refs
        return body

    def build_video_body(self, model, prompt, ratio, refs=None):
        dims = _get_video_dims(ratio)
        body: dict[str, Any] = {
            "model": model or "agnes-video-v2.0",
            "prompt": prompt,
            "width": dims["width"],
            "height": dims["height"],
            "num_frames": 121,
            "frame_rate": 24,
        }
        if refs and len(refs) == 1:
            body["image"] = refs[0]
        elif refs and len(refs) > 1:
            body["extra_body"] = {"image": refs, "mode": "keyframes"}
        return body

    def extract_image_url(self, data):
        return (data.get("data") or [None])[0].get("url") if data.get("data") else None

    def extract_video_id(self, data):
        return data.get("video_id") or data.get("id")

    def build_poll_url(self, base_url, video_id):
        return f"{base_url}/agnesapi?video_id={video_id}"

    def extract_video_result(self, data):
        state = data.get("status") or data.get("state") or ""
        if state in ("completed", "succeeded") or data.get("video_url") or data.get("url"):
            return data.get("video_url") or data.get("url") or data.get("output")
        if state in ("failed", "error"):
            return "__FAILED__"
        return None


# ── NanoBanana ─────────────────────────────────────────────────


class NanoBananaProvider(ProviderConfig):
    def __init__(self):
        super().__init__("banana", "/v1/images/generations", "")

    def build_image_body(self, model, prompt, n, ratio, size, quality="auto", refs=None):
        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "size": _resolve_size(None, ratio, size),
            "response_format": "url",
        }
        if refs:
            body["reference_images"] = refs
        return body

    def extract_image_url(self, data):
        return (data.get("data") or [None])[0].get("url") if data.get("data") else None


# ── GPT-image ──────────────────────────────────────────────────


class GPTImageProvider(ProviderConfig):
    def __init__(self):
        super().__init__("gpt-image", "/v1/images/generations", "")

    def build_image_body(self, model, prompt, n, ratio, size, quality="auto", refs=None):
        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "size": _resolve_size(None, ratio, size),
            "response_format": "url",
        }
        if quality and quality != "auto":
            body["quality"] = quality
        if refs:
            body["image"] = refs
        return body

    def extract_image_url(self, data):
        return (data.get("data") or [None])[0].get("url") if data.get("data") else None


# ── Registry ────────────────────────────────────────────────────

PROVIDERS: list[ProviderConfig] = [
    OpenAIProvider(),
    AgnesProvider(),
    NanoBananaProvider(),
    GPTImageProvider(),
]


def detect_provider(base_url: str) -> ProviderConfig:
    for p in PROVIDERS:
        if p.matches(base_url):
            return p
    return PROVIDERS[0]  # fallback to OpenAI


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
        print(f"[providers] download_and_save failed: {e}")
    return cdn_url

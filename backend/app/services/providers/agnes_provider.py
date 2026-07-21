from typing import Any

from .base import ProviderConfig, _resolve_size

# ── Agnes AI ────────────────────────────────────────────────────

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
            body["image_urls"] = refs[0]
        elif refs and len(refs) > 1:
            body["extra_body"] = {"image": refs, "mode": "keyframes"}
        return body

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

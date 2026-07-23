"""
Provider 基类与共享工具。

各具体 provider 见同目录 *_provider.py；注册表与 detect_provider 在 __init__.py。
"""

import asyncio
import base64
import logging
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

from app.config import settings
from app.services.storage import save_upload_bytes

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
    """拼接 base_url 与 endpoint。base_url 需含 /v1，suffix 只写 /v1 之后的路径。"""
    return api_base.rstrip("/") + suffix


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
        presets: list[dict[str, str]] | None = None,
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
        # 预设下拉项：每项 {"name": ..., "baseUrl": ...}，由 /api/model-config/presets 拍平返回
        self.presets = presets or []

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
        """从响应抽取结果，返回 (url, raw_bytes)：优先 url，其次 b64_json。
        返回 (None, None) 表示异步模式——worker 会调用 extract_image_task_id 等走轮询。"""
        for item in (data.get("data") or []):
            if item.get("url"):
                return item["url"], None
            b64 = item.get("b64_json")
            if b64:
                return None, base64.b64decode(b64)
        return None, None

    # ── 异步生图轮询（覆写后由 worker._process_image 调用） ──────────

    def extract_image_task_id(self, data: dict[str, Any]) -> Optional[str]:
        """从生图响应提取异步任务 ID。返回 None 表示同步模式（立即出图）。"""
        return None

    def build_image_poll_url(self, base_url: str, task_id: str) -> str:
        """构建生图任务轮询 URL。"""
        return ""

    def extract_image_poll_result(self, data: dict[str, Any]) -> Optional[str]:
        """检查轮询响应，返回：图片 URL / None(pending) / '__FAILED__'。"""
        return None

    def extract_video_id(self, data: dict[str, Any]) -> Optional[str]:
        return None

    def build_poll_url(self, base_url: str, video_id: str) -> str:
        return ""

    def extract_video_result(self, data: dict[str, Any]) -> Optional[str]:
        return None


def is_async_provider(provider: ProviderConfig) -> bool:
    return provider.max_poll_attempts > 0


# ── Download & save (used by worker) ────────────────────────────


def _is_self_url(url: str) -> bool:
    """判断 url 是否指向本服务（已是本地存储，无需再下载上传）。"""
    if any(x in url for x in ("localhost", "127.0.0.1")):
        return True
    pub = settings.PUBLIC_URL
    if pub:
        try:
            return urlparse(url).hostname == urlparse(pub).hostname
        except Exception:
            return False
    return False


async def download_and_save(cdn_url: str, user_id: int, file_type: str) -> str | None:
    """Download from CDN and save to local storage. Returns local URL, or None on failure.

    若 cdn_url 已是本服务 URL（如 b64 兜底已上传落地的情况），直接返回，避免重复存储。
    跟随重定向，但对每个跳转目标重新 SSRF 校验，防御重定向到内网/元数据。
    不携带 provider 凭证：cdn_url 不可信，禁止把 apiKey 发给下载目标。

    失败时返回 None（而非原 cdn_url）：让上层把 task 标 failed，避免把易失效的
    外链 url 当成本地结果存入 DB，导致节点 src 失效、capture_frame 等本地功能不可用。

    对瞬时错误（5xx/429/连接级）退避重试 2 次（1s → 2s），覆盖 CDN 抖动；
    4xx/超时/SSRF 拦截不重试。
    """
    # 已是本服务 URL -> 无需下载再上传（防止 b64 路径二次存储）
    if _is_self_url(cdn_url):
        return cdn_url
    from app.services.ssrf import resolve_and_validate, dns_pin, SSRFRedirectValidator

    _RETRYABLE_STATUS = {429, 500, 502, 503, 504}
    _MAX_RETRIES = 2

    try:
        ip, hostname, scheme, port = resolve_and_validate(cdn_url)
        with dns_pin(hostname, ip, port):
            async with httpx.AsyncClient(
                timeout=120,
                follow_redirects=True,
                event_hooks={"response": [SSRFRedirectValidator().async_response]},
            ) as client:
                # 重试循环：对瞬时错误退避重试，永久错误直接放弃
                for attempt in range(_MAX_RETRIES + 1):
                    try:
                        resp = await client.get(cdn_url)
                    except (httpx.TransportError, httpx.RemoteProtocolError) as e:
                        if attempt < _MAX_RETRIES:
                            logger.warning(f"download retryable transport err attempt={attempt+1} url={cdn_url[:60]} err={str(e)[:80]}")
                            await asyncio.sleep(1 * (attempt + 1))
                            continue
                        logger.warning(f"download failed after retries url={cdn_url[:60]} err={str(e)[:120]}")
                        return None

                    if resp.is_success:
                        # 下载成功 -> 直接落盘去重（不再自调 HTTP / 伪造 JWT）
                        url = await save_upload_bytes(
                            user_id=user_id,
                            content=resp.content,
                            category="generated",
                            ext="mp4" if file_type == "video" else "png",
                        )
                        if url:
                            return url
                        logger.warning(f"download_and_save storage failed url={cdn_url[:60]}")
                        return None

                    if resp.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                        logger.warning(f"download retryable status={resp.status_code} attempt={attempt+1} url={cdn_url[:60]}")
                        await asyncio.sleep(1 * (attempt + 1))
                        continue
                    # 4xx 或重试用尽
                    logger.warning(f"download_and_save bad status={resp.status_code} url={cdn_url[:60]}")
                    return None
    except HTTPException:
        # SSRF 校验拦截（cdn_url 或重定向目标指向内网/元数据）-> 不落地
        logger.warning(f"download_and_save ssrf blocked url={cdn_url[:60]}")
        return None
    except Exception as e:
        logger.warning(f"download_and_save failed url={cdn_url[:60]} err={str(e)[:120]}")
        return None
    return None

"""
Provider 基类与共享工具。

各具体 provider 见同目录 *_provider.py；注册表与 detect_provider 在 __init__.py。
"""

import asyncio
import base64
import logging
import random
import time
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

from app.config import settings
from app.services.http import HTTPX_TIMEOUT
from app.services.storage import save_upload_bytes

logger = logging.getLogger(__name__)


def _exc(e: Exception, n: int = 120) -> str:
    """格式化异常：保证带上类型名，即使消息为空也能定位根因。"""
    msg = str(e)
    return f"{type(e).__name__}{(': ' + msg[:n]) if msg else ''}"

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

    def extract_image(self, data: dict[str, Any]) -> tuple[list[str], list[bytes]]:
        """从响应抽取所有结果，返回 (urls, raw_bytes_list)。

        遍历 data[] 收集全部 url 与 b64，不再只取第一张——支持一次返回多张图。
        返回 ([], []) 表示异步模式——worker 会调用 extract_image_task_id 等走轮询。
        """
        urls: list[str] = []
        raw_list: list[bytes] = []
        for item in (data.get("data") or []):
            if item.get("url"):
                urls.append(item["url"])
            b64 = item.get("b64_json")
            if b64:
                raw_list.append(base64.b64decode(b64))
        return urls, raw_list

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


# ── 慢速检测（沿用参考实现）────────────────────────────────────
# httpx 的 read 超时是"字节间隔"语义，对稳定滴流永远不触发；
# 此处按总耗时算平均速度，低于阈值主动放弃，避免被慢源长期占用协程。
_SLOW_AFTER = 30       # 秒：开始评估平均速度的最小时长
_SLOW_SPEED = 1024     # bytes/s：低于此平均速度判定为滴流，主动放弃


def _backoff(attempt: int) -> float:
    """指数退避 + 随机抖动，上限 30s。attempt 从 0 开始。

    2^0→~1s, 2^1→~2s, 2^2→~4s, 2^3→~8s, 2^4→~16s, 封顶 30s。
    抖动避免多协程同时重试造成"惊群"。
    """
    return min(2 ** attempt + random.random(), 30.0)


async def _stream_download(client, cdn_url: str, _tid: str) -> bytes:
    """流式下载 + 慢速检测。返回完整 bytes；超时/过慢/传输错向上抛。

    用 stream + aiter_bytes 替代 client.get 一次性读内存，使每收到一个
    chunk 都有机会评估平均速度。配合外层 asyncio.wait_for 提供"总耗时"硬兜底。
    """
    buf = bytearray()
    start = time.monotonic()
    async with client.stream("GET", cdn_url) as resp:
        resp.raise_for_status()  # 4xx/5xx -> httpx.HTTPStatusError
        async for chunk in resp.aiter_bytes(65536):
            buf.extend(chunk)
            elapsed = time.monotonic() - start
            speed = len(buf) / elapsed if elapsed > 0 else 0
            if elapsed > _SLOW_AFTER and speed < _SLOW_SPEED:
                raise Exception(f"download too slow{_tid} {speed:.2f} bytes/s")
    return bytes(buf)


async def download_and_save(cdn_url: str, user_id: int, file_type: str, task_id: str = "") -> str | None:
    """Download from CDN and save to local storage. Returns local URL, or None on failure.

    若 cdn_url 已是本服务 URL（如 b64 兜底已上传落地的情况），直接返回，避免重复存储。
    跟随重定向，但对每个跳转目标重新 SSRF 校验，防御重定向到内网/元数据。
    不携带 provider 凭证：cdn_url 不可信，禁止把 apiKey 发给下载目标。

    失败时返回 None（而非原 cdn_url）：让上层把 task 标 failed，避免把易失效的
    外链 url 当成本地结果存入 DB，导致节点 src 失效、capture_frame 等本地功能不可用。

    对瞬时错误退避重试 5 次（指数退避 + 抖动，封顶 30s）：
      - 429/500/502/503/504：服务端瞬时错误/限流，可重试；
      - ConnectTimeout/ConnectError：CDN 不可达，可重试；
      - ReadTimeout/RemoteProtocolError/其它 TransportError：传输中断，可重试。
    400/401/403/404、SSRF 拦截、本地慢速滴流不重试。
    """
    _tid = f" task={task_id}" if task_id else ""
    # 已是本服务 URL -> 无需下载再上传（防止 b64 路径二次存储）
    if _is_self_url(cdn_url):
        return cdn_url
    from app.services.ssrf import resolve_and_validate, dns_pin, SSRFRedirectValidator

    _RETRYABLE_STATUS = {429, 500, 502, 503, 504}
    _MAX_RETRIES = 5

    logger.info(f"download_and_save start{_tid} user={user_id} type={file_type} url={cdn_url}")

    try:
        _t0 = time.monotonic()
        ip, hostname, scheme, port = resolve_and_validate(cdn_url)
        logger.info(f"download dns ok{_tid} ip={ip} cost={time.monotonic()-_t0:.2f}s")
        with dns_pin(hostname, ip, port):
            async with httpx.AsyncClient(
                timeout=HTTPX_TIMEOUT,
                follow_redirects=True,
                # 图片 CDN URL 是一次性短链，keepalive 无意义还占连接池，关闭复用
                limits=httpx.Limits(max_keepalive_connections=0),
                event_hooks={"response": [SSRFRedirectValidator().async_response]},
            ) as client:
                # 重试循环：对瞬时错误退避重试，永久错误直接放弃
                for attempt in range(_MAX_RETRIES + 1):
                    _n = f"{attempt+1}/{_MAX_RETRIES+1}"
                    try:
                        _t1 = time.monotonic()
                        # asyncio.wait_for 提供"总耗时"硬兜底：httpx 内部 read 超时对
                        # 慢速滴流无效，此处保证整个请求最多占用 DL_READ 秒。
                        content = await asyncio.wait_for(
                            _stream_download(client, cdn_url, _tid),
                            timeout=settings.HTTP_DL_READ,
                        )
                        logger.info(
                            f"download http ok{_tid} size={len(content)} "
                            f"cost={time.monotonic()-_t1:.2f}s"
                        )
                    except asyncio.TimeoutError:
                        # 总耗时超上限（含 connect/read 在 Windows 下不触发的兜底）
                        if attempt < _MAX_RETRIES:
                            logger.warning(f"download total-timeout attempt={_n} url={cdn_url}")
                            await asyncio.sleep(_backoff(attempt))
                            continue
                        logger.warning(f"download total-timeout after retries url={cdn_url}")
                        return None
                    except (httpx.ConnectTimeout, httpx.ConnectError) as e:
                        # CDN 不可达：TCP 连不上，通常需等待更久恢复
                        if attempt < _MAX_RETRIES:
                            logger.warning(f"download unreachable attempt={_n} url={cdn_url} err={_exc(e, 80)}")
                            await asyncio.sleep(_backoff(attempt))
                            continue
                        logger.warning(f"download unreachable after retries url={cdn_url} err={_exc(e, 120)}")
                        return None
                    except (httpx.ReadTimeout, httpx.RemoteProtocolError) as e:
                        # 传输中断：连上了但读到一半断/协议错误
                        if attempt < _MAX_RETRIES:
                            logger.warning(f"download transport err attempt={_n} url={cdn_url} err={_exc(e, 80)}")
                            await asyncio.sleep(_backoff(attempt))
                            continue
                        logger.warning(f"download transport failed after retries url={cdn_url} err={_exc(e, 120)}")
                        return None
                    except httpx.HTTPStatusError as e:
                        if e.response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                            logger.warning(f"download retryable status={e.response.status_code} attempt={_n} url={cdn_url}")
                            await asyncio.sleep(_backoff(attempt))
                            continue
                        logger.warning(f"download_and_save bad status={e.response.status_code} url={cdn_url}")
                        return None
                    except httpx.TransportError as e:
                        # 其它传输层错误（WriteTimeout / PoolTimeout 等）
                        if attempt < _MAX_RETRIES:
                            logger.warning(f"download transport err attempt={_n} url={cdn_url} err={_exc(e, 80)}")
                            await asyncio.sleep(_backoff(attempt))
                            continue
                        logger.warning(f"download failed after retries url={cdn_url} err={_exc(e, 120)}")
                        return None
                    except Exception as e:
                        # 慢速检测 raise 的 Exception 等其它瞬时错误
                        if attempt < _MAX_RETRIES:
                            logger.warning(f"download too slow retry attempt={_n} url={cdn_url} err={_exc(e, 80)}")
                            await asyncio.sleep(_backoff(attempt))
                            continue
                        logger.warning(f"download failed after retries url={cdn_url} err={_exc(e, 120)}")
                        return None

                    # 流式下载成功 -> 直接落盘去重（不再自调 HTTP / 伪造 JWT）
                    logger.info(f"download_and_save downloaded{_tid} size={len(content)} bytes, saving...")
                    _t2 = time.monotonic()
                    url = await save_upload_bytes(
                        user_id=user_id,
                        content=content,
                        category="generated",
                        ext="mp4" if file_type == "video" else "png",
                    )
                    logger.info(f"download save ok{_tid} cost={time.monotonic()-_t2:.2f}s local={url}")
                    if url:
                        logger.info(f"download_and_save done{_tid} local={url}")
                        return url
                    logger.warning(f"download_and_save storage failed{_tid} url={cdn_url}")
                    return None
    except HTTPException:
        # SSRF 校验拦截（cdn_url 或重定向目标指向内网/元数据）-> 不落地
        logger.warning(f"download_and_save ssrf blocked url={cdn_url}")
        return None
    except Exception as e:
        logger.warning(f"download_and_save failed url={cdn_url} err={_exc(e, 120)}")
        return None
    return None

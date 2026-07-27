"""参考图 / 同源文件解析。

从 worker 迁出（行为保持不变）：
  - _MEDIA_TYPE_MAP
  - read_self_file  (原 worker._read_self_file)
  - resolve_refs    (原 worker._resolve_refs)

resolve_refs 三档策略：
  1) 同源 URL      → 直接读本机磁盘转 base64（无出网，消除 hairpin）
  2) 白名单内 URL  → dns_pin 安全 fetch 后转 base64
  3) 其它外链      → 透传原串（不下载，交由 provider 自行访问）
"""

import base64
import logging
import os

import httpx

from app.services.http import TIMEOUT_DOWNLOAD

logger = logging.getLogger(__name__)


_MEDIA_TYPE_MAP = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


def read_self_file(url: str, user_id: int) -> tuple[bytes, str] | None:
    """同源文件 URL → 直接读本机磁盘，免出网（消除 hairpin）。

    仅接受 /api/files/{uid}/{sub}/{hash}{ext} 或 /api/files/{uid}/frames/{name} 形态。
    返回 (bytes, mime)，或 None（不读盘）。
    """
    from app.services import media

    if "/api/files/" not in url:
        return None
    rel = url.split("/api/files/", 1)[-1]
    parts = [p for p in rel.split("/") if p]
    if len(parts) < 3:
        return None
    try:
        uid = int(parts[0])
    except ValueError:
        return None
    sub = parts[1]
    if sub != "frames" and (len(sub) != 2 or not sub.isalnum()):
        return None
    if uid != user_id:
        logger.warning(f"read_self_file uid mismatch: url uid={uid} task uid={user_id}")
        return None
    try:
        full_path = media.validate_user_file(rel, user_id)
    except (FileNotFoundError, PermissionError, ValueError):
        return None
    # 双保险：realpath + 前缀守卫（防符号链接/逃逸）
    real = os.path.realpath(full_path)
    root = os.path.realpath(media.UPLOAD_DIR)
    if not (real == root or real.startswith(root + os.sep)):
        return None
    try:
        with open(real, "rb") as f:
            data = f.read()
    except OSError:
        return None
    ext = os.path.splitext(real)[1].lower()
    mime = _MEDIA_TYPE_MAP.get(ext, "application/octet-stream")
    return data, mime


async def resolve_refs(ref_images: list[str], user_id: int) -> list[str]:
    """Convert self/allowed file URLs to base64 data URLs (external providers can't reach localhost).

    三档：
      1) 同源 URL → 直接读本机磁盘转 base64（无出网，消除 hairpin）
      2) 白名单内 URL → dns_pin 安全 fetch 后转 base64
      3) 其它外链 → 透传原串（不下载，交由 provider 自行访问）
    """
    if not ref_images:
        return []
    resolved: list[str] = []
    from app.services.ssrf import (
        is_self_url,
        is_allowed_ref_host,
        _validate_worker,
        dns_pin,
    )

    for url in ref_images:
        # 1) 同源 → 读盘（无出网）
        if is_self_url(url):
            pair = read_self_file(url, user_id)
            if pair:
                data, mime = pair
                b64 = base64.b64encode(data).decode()
                resolved.append(f"data:{mime};base64,{b64}")
                continue
        # 2) 白名单 → dns_pin 安全 fetch
        if is_allowed_ref_host(url):
            try:
                ip, hostname, scheme, port = _validate_worker(url)
            except Exception:
                resolved.append(url)
                continue
            try:
                async with httpx.AsyncClient(timeout=TIMEOUT_DOWNLOAD) as client:
                    with dns_pin(hostname, ip, port):
                        resp = await client.get(url)
                if resp.is_success:
                    b64 = base64.b64encode(resp.content).decode()
                    mime = resp.headers.get("content-type", "image/png")
                    resolved.append(f"data:{mime};base64,{b64}")
                    continue
            except Exception:
                pass
        # 3) 其它外链 → 透传
        resolved.append(url)
    return resolved

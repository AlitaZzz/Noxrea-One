"""
storage.py — 统一的文件落盘 + 去重 + DB 记录服务。

把之前散落在 routers/files.py、services/providers/base.py、services/worker.py
里的「存一个文件」逻辑收敛到这里，作为唯一存储入口。所有调用方（HTTP 上传路由、
worker 落地 provider 结果、bg_removal 结果）都走 save_upload_bytes，不再自调
HTTP / 伪造 JWT，也消除了 worker 绕一圈回环本服务存储的脆弱依赖。

复用 app.database 的共享 engine（单一连接池），避免 worker 自建第二个 engine
导致的双连接池 / WAL 不一致问题。
"""

import hashlib
import logging
import os

from sqlalchemy import text as _sql
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session
from app.services.media import UPLOAD_DIR

logger = logging.getLogger(__name__)

# category -> file_objects.source
SOURCE_MAP = {
    "assets": "asset_upload",
    "images": "node_upload",
    "videos": "node_upload",
    "generated": "ai_generated",
    "avatars": "avatar_upload",
}

# sniffed mime -> 扩展名（无点）
_MIME_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
}


def _sniff_mime(data: bytes) -> str | None:
    """按 magic bytes 判定真实类型；不在白名单内返回 None（拒绝存储）。

    content_type 由客户端提供可伪造，故以真实内容为准。
    """
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"GIF8"):
        return "image/gif"
    if data[4:8] == b"ftyp":
        return "video/mp4"  # ISO BMFF（mp4/mov 等）
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"  # EBML/Matroska
    if data.startswith(b"ID3") or data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data.startswith(b"OggS"):
        return "audio/ogg"
    if data.startswith(b"fLaC"):
        return "audio/flac"
    return None


def _normalize_ext(ext: str | None, content_type: str) -> str:
    """统一规范化扩展名：带点；缺省时按 mime 推导，再兜底 .png。"""
    if ext:
        return ext if ext.startswith(".") else "." + ext
    mapped = _MIME_EXT.get(content_type)
    if mapped:
        return "." + mapped
    return ".png"


async def save_upload_bytes(
    *,
    user_id: int,
    content: bytes,
    category: str,
    filename: str | None = None,
    ext: str | None = None,
    max_bytes: int | None = None,
) -> str | None:
    """落盘 + 去重 + 写 file_objects，返回公开 URL；失败返回 None。

    自开 AsyncSession（共享 engine）并提交，调用方无需持有 db。

    - 大小上限默认 settings.MAX_UPLOAD_SIZE_MB，可按调用方放宽/收紧
    - magic bytes 校验，拒绝白名单外类型
    - SHA256 去重：同用户同内容只落一份物理副本，仅刷新 updated_at
    """
    if max_bytes is None:
        max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    if len(content) > max_bytes:
        logger.warning(f"save_upload_bytes too large user={user_id} size={len(content)} max={max_bytes}")
        return None

    sniffed = _sniff_mime(content)
    if not sniffed:
        logger.warning(f"save_upload_bytes unsupported/forged type user={user_id}")
        return None
    content_type = sniffed

    if not ext and filename:
        ext = os.path.splitext(filename)[1] or None
    ext = _normalize_ext(ext, content_type)

    file_hash = hashlib.sha256(content).hexdigest()
    source = SOURCE_MAP.get(category, "unknown")

    async with async_session() as db:
        row = await db.execute(
            _sql("SELECT hash FROM file_objects WHERE user_id = :uid AND hash = :h"),
            {"uid": user_id, "h": file_hash},
        )
        existing = row.fetchone()

        if existing:
            await db.execute(
                _sql("UPDATE file_objects SET updated_at = CURRENT_TIMESTAMP WHERE user_id = :uid AND hash = :h"),
                {"uid": user_id, "h": file_hash},
            )
            await db.commit()
            logger.debug(f"save_upload_bytes dedup hit user={user_id} hash={file_hash}")
        else:
            sub = file_hash[:2]
            full_dir = os.path.join(UPLOAD_DIR, str(user_id), sub)
            full_path = os.path.join(full_dir, f"{file_hash}{ext}")
            os.makedirs(full_dir, exist_ok=True)
            with open(full_path, "wb") as f:
                f.write(content)

            await db.execute(
                _sql("""INSERT INTO file_objects (user_id, hash, size, mime_type, ext, source)
                         VALUES (:uid, :h, :sz, :mime, :ext, :src)"""),
                {"uid": user_id, "h": file_hash, "sz": len(content),
                 "mime": content_type, "ext": ext, "src": source},
            )
            await db.commit()

    url = f"{settings.PUBLIC_URL}/api/files/{user_id}/{file_hash[:2]}/{file_hash}{ext}"
    logger.info(f"save_upload_bytes ok user={user_id} size={len(content)} url={url}")
    return url

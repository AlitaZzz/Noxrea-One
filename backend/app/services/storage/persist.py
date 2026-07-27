"""
persist.py — 核心文件落盘 + 去重 + DB 记录实现（app.services.storage 包的底层）。

把之前散落在 routers/files.py、services/providers/base.py、services/worker.py
里的「存一个文件」逻辑收敛到这里，作为唯一存储入口。所有调用方（HTTP 上传路由、
worker 落地 provider 结果、bg_removal 结果）都走 save_upload_bytes，不再自调
HTTP / 伪造 JWT，也消除了 worker 绕一圈回环本服务存储的脆弱依赖。

复用 app.database 的共享 engine（单一连接池），避免 worker 自建第二个 engine
导致的双连接池 / WAL 不一致问题。

高层封装见 service.py（StorageService），下载+落盘见 download.py。
"""

import asyncio
import hashlib
import logging
import os

from sqlalchemy import text as _sql
from sqlalchemy.exc import IntegrityError

from ...config import settings
from ...database import async_session
from ...logging_config import log_event
from ..media import UPLOAD_DIR

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


def sniff_mime(data: bytes) -> str | None:
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


def normalize_ext(ext: str | None, content_type: str) -> str:
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
        logger.warning(log_event("storage", stage="too_large", user=user_id, size=len(content), max=max_bytes))
        return None

    sniffed = sniff_mime(content)
    if not sniffed:
        logger.warning(log_event("storage", stage="unsupported_type", user=user_id))
        return None
    content_type = sniffed

    if not ext and filename:
        ext = os.path.splitext(filename)[1] or None
    ext = normalize_ext(ext, content_type)

    file_hash = hashlib.sha256(content).hexdigest()
    source = SOURCE_MAP.get(category, "unknown")

    sub = file_hash[:2]
    full_dir = os.path.join(UPLOAD_DIR, str(user_id), sub)
    full_path = os.path.join(full_dir, f"{file_hash}{ext}")
    url = f"{settings.PUBLIC_URL}/api/files/{user_id}/{file_hash[:2]}/{file_hash}{ext}"

    # 先落盘（同内容同路径，覆盖无影响），再 INSERT，catch IntegrityError 作为去重
    os.makedirs(full_dir, exist_ok=True)
    try:
        with open(full_path, "wb") as f:
            f.write(content)
    except PermissionError:
        if not os.path.exists(full_path):
            raise
        # Windows：目标文件被锁（如 FileResponse 正在服务同 hash 文件），
        # 但已存在且内容相同，跳过写入

    async with async_session() as db:
        try:
            await db.execute(
                _sql("""INSERT INTO file_objects (user_id, hash, size, mime_type, ext, source)
                         VALUES (:uid, :h, :sz, :mime, :ext, :src)"""),
                {"uid": user_id, "h": file_hash, "sz": len(content),
                 "mime": content_type, "ext": ext, "src": source},
            )
            await db.commit()
            logger.info(log_event("storage", stage="saved", user=user_id, size=len(content), url=url))
        except IntegrityError:
            # 并发去重：另一请求已先插入相同 hash
            await db.rollback()
            await db.execute(
                _sql("UPDATE file_objects SET updated_at = CURRENT_TIMESTAMP WHERE user_id = :uid AND hash = :h"),
                {"uid": user_id, "h": file_hash},
            )
            await db.commit()
            logger.debug(log_event("storage", stage="dedup_hit", user=user_id, hash=file_hash))

    return url


async def save_upload_from_path(
    *,
    user_id: int,
    temp_path: str,
    file_hash: str,
    size: int,
    content_type: str,
    ext: str,
    category: str,
) -> str | None:
    """将已落盘的 temp 文件移入正式存储 + 去重 + 写 file_objects，返回公开 URL。

    与 save_upload_bytes 的区别：调用方已完成流式写入和 hash 计算，
    本函数只负责文件移动（os.replace）和 DB 记录。

    采用「先移动文件，再 INSERT，catch IntegrityError」策略消除竞态：
    不依赖 SELECT 结果，INSERT 冲突即去重命中，彻底规避并发竞态。
    """
    source = SOURCE_MAP.get(category, "unknown")
    sub = file_hash[:2]
    full_dir = os.path.join(UPLOAD_DIR, str(user_id), sub)
    full_path = os.path.join(full_dir, f"{file_hash}{ext}")
    url = f"{settings.PUBLIC_URL}/api/files/{user_id}/{file_hash[:2]}/{file_hash}{ext}"

    # 先移动文件到正式存储；Windows 上 os.replace 可能因文件锁定（AV 扫描、
    # FileResponse 服务中）失败，用重试 + 回退处理
    os.makedirs(full_dir, exist_ok=True)
    for attempt in range(5):
        try:
            os.replace(temp_path, full_path)
            break
        except PermissionError:
            if os.path.exists(full_path):
                # 目标已存在且被锁（同内容），删除 temp 跳过移动
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
                break
            if attempt < 4:
                await asyncio.sleep(0.1 * (attempt + 1))
                continue
            raise

    async with async_session() as db:
        try:
            await db.execute(
                _sql("""INSERT INTO file_objects (user_id, hash, size, mime_type, ext, source)
                         VALUES (:uid, :h, :sz, :mime, :ext, :src)"""),
                {"uid": user_id, "h": file_hash, "sz": size,
                 "mime": content_type, "ext": ext, "src": source},
            )
            await db.commit()
            logger.info(log_event("storage", stage="saved", user=user_id, size=size, url=url))
        except IntegrityError:
            # 并发去重：另一请求已先插入相同 hash，temp 文件已移到 full_path（内容相同）
            await db.rollback()
            await db.execute(
                _sql("UPDATE file_objects SET updated_at = CURRENT_TIMESTAMP WHERE user_id = :uid AND hash = :h"),
                {"uid": user_id, "h": file_hash},
            )
            await db.commit()
            logger.debug(log_event("storage", stage="dedup_hit", user=user_id, hash=file_hash))

    return url

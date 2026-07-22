import uuid
import os
import hashlib
import logging

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, status, Query
from fastapi.responses import FileResponse
from sqlalchemy import text as _sql
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.common import UnifiedResponse
from app.deps import get_current_user, get_db
from app.config import settings
from app.services.media import (
    UPLOAD_DIR as _UPLOAD_DIR,
    IMAGE_EXTS,
    resize_and_cache_image,
    extract_video_frame,
    validate_user_file,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/files", tags=["files"])

UPLOAD_DIR = _UPLOAD_DIR
CACHE_DIR = os.path.join(_UPLOAD_DIR, "_cache")


def get_upload_dir(user_id: int, category: str = "") -> str:
    """目录: uploads/{user_id}[/{category}]"""
    parts = [UPLOAD_DIR, str(user_id)]
    if category:
        parts.append(category)
    target = os.path.join(*parts)
    os.makedirs(target, exist_ok=True)
    return target


def _sniff_mime(data: bytes) -> str | None:
    """按 magic bytes 判定真实类型；不在白名单内返回 None（拒绝上传）。

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


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    category: str = Query(...),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    content_type = file.content_type or ""
    if not (
        content_type.startswith("image/")
        or content_type.startswith("video/")
        or content_type.startswith("audio/")
    ):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only images, videos, and audio allowed")

    # 分块读取 + 大小限制（避免一次性 read 大文件导致 OOM）
    max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=f"File too large (max {settings.MAX_UPLOAD_SIZE_MB}MB)",
            )
        chunks.append(chunk)
    content = b"".join(chunks)

    # magic bytes 校验：以真实内容为准，忽略可伪造的 content_type
    sniffed = _sniff_mime(content)
    if not sniffed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported or invalid file type",
        )
    content_type = sniffed

    ext = os.path.splitext(file.filename or "image.png")[1] or ".png"
    if not ext or ext == ".":
        if "video" in content_type:
            ext = ".mp4"
        elif "audio" in content_type:
            ext = ".mp3"
        else:
            ext = ".png"

    file_hash = hashlib.sha256(content).hexdigest()

    source_map = {"assets": "asset_upload", "images": "node_upload", "videos": "node_upload", "generated": "ai_generated", "avatars": "avatar_upload"}
    source = source_map.get(category, "unknown")

    row = await db.execute(
        _sql("SELECT hash FROM file_objects WHERE user_id = :uid AND hash = :h"),
        {"uid": user.id, "h": file_hash},
    )
    existing = row.fetchone()

    if existing:
        await db.execute(
            _sql("UPDATE file_objects SET updated_at = CURRENT_TIMESTAMP WHERE user_id = :uid AND hash = :h"),
            {"uid": user.id, "h": file_hash},
        )
        await db.commit()
        logger.debug(f"dedup hit user={user.id} hash={file_hash}")
    else:
        sub = file_hash[:2]
        full_dir = os.path.join(UPLOAD_DIR, str(user.id), sub)
        full_path = os.path.join(full_dir, f"{file_hash}{ext}")
        os.makedirs(full_dir, exist_ok=True)
        with open(full_path, "wb") as f:
            f.write(content)

        await db.execute(
            _sql("""INSERT INTO file_objects (user_id, hash, size, mime_type, ext, source)
                     VALUES (:uid, :h, :sz, :mime, :ext, :src)"""),
            {"uid": user.id, "h": file_hash, "sz": len(content),
             "mime": content_type, "ext": ext, "src": source},
        )
        await db.commit()

    url = f"{settings.PUBLIC_URL}/api/files/{user.id}/{file_hash[:2]}/{file_hash}{ext}"
    logger.info(f"upload ok user={user.id} size={len(content)} url={url}")
    return UnifiedResponse(code=200, data={"url": url, "filename": f"{file_hash}{ext}"}, msg="uploaded")


@router.get("/{filepath:path}")
async def get_file(
    filepath: str,
    w: int = Query(None, ge=1, le=4096, description="Resize image width in pixels"),
):
    """
    TODO: 文件访问鉴权 — 当前完全公开，任何人拿到 URL 可读取任意用户文件。
    已知安全缺口，等独立方案确定后再处理（当前进度的阶段性决策，非疏忽）。
    """
    full_path = os.path.realpath(os.path.join(UPLOAD_DIR, filepath))
    upload_root = os.path.realpath(UPLOAD_DIR)
    # 路径穿越拦截：解析 .. 与符号链接后必须仍在 UPLOAD_DIR 之内，越界统一 404 不暴露存在性
    if not (full_path == upload_root or full_path.startswith(upload_root + os.sep)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    ext = os.path.splitext(filepath)[1].lower()
    media_type_map = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }
    media_type = media_type_map.get(ext, "application/octet-stream")

    headers = {"Access-Control-Allow-Origin": "*"}

    # Serve resized image when ?w= is specified
    if w is not None and ext in IMAGE_EXTS:
        cache_path = resize_and_cache_image(full_path, w, CACHE_DIR)
        if cache_path:
            return FileResponse(cache_path, media_type="image/webp", headers=headers)
        # Fallback to original on any processing error

    # For video, support range requests
    if ext in (".mp4", ".webm"):
        headers["Accept-Ranges"] = "bytes"

    return FileResponse(full_path, media_type=media_type, headers=headers)


@router.post("/capture-frame")
async def capture_frame(body: dict, user=Depends(get_current_user)):
    """Extract a frame from a video file. body: { url: str, time: float }"""
    video_url = body.get("url", "")
    seek_time = body.get("time", 0)

    if not video_url or "/api/files/" not in video_url:
        raise HTTPException(status_code=400, detail="Invalid video URL")

    rel = video_url.split("/api/files/")[-1]

    try:
        video_path = validate_user_file(rel, user.id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Video not found")
    except PermissionError:
        raise HTTPException(status_code=403, detail="Access denied")

    out_dir = get_upload_dir(user.id, "frames")

    try:
        out_path = extract_video_frame(video_path, seek_time, out_dir, timeout=30)
        if not out_path:
            raise HTTPException(status_code=500, detail="Frame extraction failed")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="ffmpeg not installed")
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)[:200])

    frame_name = os.path.basename(out_path)
    url = f"{settings.PUBLIC_URL}/api/files/{user.id}/frames/{frame_name}"
    logger.info(f"frame captured user={user.id} time={seek_time}s url={url}")
    return UnifiedResponse(code=200, data={"url": url}, msg="frame captured")

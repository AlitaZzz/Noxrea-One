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


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    category: str = Query(...),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    content_type = file.content_type or ""
    if not content_type or not (
        content_type.startswith("image/")
        or content_type.startswith("video/")
        or content_type.startswith("audio/")
    ):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only images, videos, and audio allowed")

    ext = os.path.splitext(file.filename or "image.png")[1] or ".png"
    if not ext or ext == ".":
        if "video" in content_type:
            ext = ".mp4"
        elif "audio" in content_type:
            ext = ".mp3"
        else:
            ext = ".png"

    content = await file.read()
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
        logger.info(f"dedup hit: user={user.id} hash={file_hash}")
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
    full_path = os.path.join(UPLOAD_DIR, filepath)
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
    return UnifiedResponse(code=200, data={"url": url}, msg="frame captured")


@router.delete("/{filepath:path}")
async def delete_file(filepath: str, user=Depends(get_current_user)):
    """
    当前不建议使用。去重体系下直接删物理文件可能影响其他引用同一 hash 的资源。
    资产删除请通过 DELETE /api/assets/items/{id} 操作（仅减 ref_count，不删文件）。
    """
    try:
        full_path = validate_user_file(filepath, user.id)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    except PermissionError:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot delete other user's files")

    os.remove(full_path)

    base_name = os.path.splitext(os.path.basename(filepath))[0]
    cache_sub = os.path.dirname(filepath)
    cache_dir_path = os.path.join(CACHE_DIR, cache_sub)
    if os.path.isdir(cache_dir_path):
        for fname in os.listdir(cache_dir_path):
            if fname.startswith(base_name + "_w"):
                try:
                    os.remove(os.path.join(cache_dir_path, fname))
                except OSError:
                    pass

    return UnifiedResponse(code=200, msg="deleted")

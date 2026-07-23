import os
import hashlib
import logging

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, status, Query
from fastapi.responses import FileResponse

from app.schemas.common import UnifiedResponse
from app.deps import get_current_user
from app.config import settings
from app.services.media import (
    UPLOAD_DIR as _UPLOAD_DIR,
    IMAGE_EXTS,
    resize_and_cache_image,
    extract_video_frame,
    validate_user_file,
)
from app.services.storage import save_upload_bytes

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
    user=Depends(get_current_user),
):
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

    # 落盘 + 去重 + DB 记录统一交给 storage 处理（含 magic bytes 校验与类型白名单）
    url = await save_upload_bytes(
        user_id=user.id,
        content=content,
        category=category,
        filename=file.filename,
    )
    if url is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported or invalid file type",
        )

    ext = os.path.splitext(file.filename or "image.png")[1] or ".png"
    file_hash = hashlib.sha256(content).hexdigest()
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
    logger.info(f"capture-frame requested user={user.id} url={video_url} time={seek_time}s")

    if not video_url or "/api/files/" not in video_url:
        logger.warning(f"capture-frame invalid url user={user.id} url={video_url}")
        raise HTTPException(status_code=400, detail="Invalid video URL")

    rel = video_url.split("/api/files/")[-1]

    try:
        video_path = validate_user_file(rel, user.id)
    except FileNotFoundError:
        logger.warning(f"capture-frame video not found user={user.id} rel={rel}")
        raise HTTPException(status_code=404, detail="Video not found")
    except PermissionError:
        logger.warning(f"capture-frame access denied user={user.id} rel={rel}")
        raise HTTPException(status_code=403, detail="Access denied")

    out_dir = get_upload_dir(user.id, "frames")

    try:
        out_path = extract_video_frame(video_path, seek_time, out_dir, timeout=30)
        if not out_path:
            logger.error(f"capture-frame extraction returned empty user={user.id} src={video_path}")
            raise HTTPException(status_code=500, detail="Frame extraction failed")
    except FileNotFoundError:
        logger.error(f"capture-frame failed: ffmpeg not installed user={user.id} src={video_path}")
        raise HTTPException(status_code=500, detail="ffmpeg not installed")
    except RuntimeError as e:
        logger.error(f"capture-frame runtime error user={user.id} src={video_path} err={str(e)[:200]}")
        raise HTTPException(status_code=500, detail=str(e)[:200])

    frame_name = os.path.basename(out_path)
    url = f"{settings.PUBLIC_URL}/api/files/{user.id}/frames/{frame_name}"
    logger.info(f"frame captured user={user.id} time={seek_time}s url={url}")
    return UnifiedResponse(code=200, data={"url": url}, msg="frame captured")

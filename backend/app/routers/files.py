import os
import hashlib
import logging
import tempfile
from urllib.parse import quote

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
from app.services.storage import save_upload_from_path, sniff_mime, normalize_ext

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
    # 流式上传：边读边写 temp file + 增量 SHA256，避免大文件全量加载到内存
    max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    chunk_size = 1024 * 1024  # 1MB per chunk

    hasher = hashlib.sha256()
    total = 0
    first_chunk = b""

    # temp 文件与 UPLOAD_DIR 同文件系统（os.replace 需要同分区才能原子移动）
    fd, temp_path = tempfile.mkstemp(suffix=".tmp", dir=UPLOAD_DIR)

    try:
        with os.fdopen(fd, "wb") as f:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                        detail=f"File too large (max {settings.MAX_UPLOAD_SIZE_MB}MB)",
                    )
                f.write(chunk)
                hasher.update(chunk)
                if not first_chunk:
                    first_chunk = chunk

        if total == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Empty file",
            )

        # magic bytes 校验（只需首个 chunk）
        sniffed = sniff_mime(first_chunk)
        if not sniffed:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unsupported or invalid file type",
            )

        ext = normalize_ext(
            os.path.splitext(file.filename or "")[1] or None,
            sniffed,
        )
        file_hash = hasher.hexdigest()

        url = await save_upload_from_path(
            user_id=user.id,
            temp_path=temp_path,
            file_hash=file_hash,
            size=total,
            content_type=sniffed,
            ext=ext,
            category=category,
        )
        if url is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unsupported or invalid file type",
            )

        logger.info(f"upload ok user={user.id} size={total} url={url}")
        return UnifiedResponse(
            code=200,
            data={"url": url, "filename": f"{file_hash}{ext}"},
            msg="uploaded",
        )
    except Exception:
        # 异常时清理 temp 文件
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass
        raise


@router.get("/{filepath:path}")
async def get_file(
    filepath: str,
    w: int = Query(None, ge=1, le=4096, description="Resize image width in pixels"),
    download: bool = Query(False, description="Trigger browser download via Content-Disposition"),
    filename: str = Query(None, description="Override download filename (URL-decoded by FastAPI)"),
):
    """
    TODO: 文件访问鉴权 - 当前完全公开，任何人拿到 URL 可读取任意用户文件。
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

    # ?download=true -> 浏览器原生下载（Content-Disposition: attachment）
    # 绕开 fetch+blob 路径，避免 Chrome blob_storage 大文件限制
    # 使用 FileResponse 的 filename 参数让 Starlette 自动生成 Content-Disposition
    download_filename = None
    if download:
        safe_name = os.path.basename(filename) if filename else os.path.basename(filepath)
        # 确保文件名以原始扩展名结尾
        if not safe_name.lower().endswith(ext):
            safe_name += ext
        download_filename = safe_name
        logger.info(f"download filename={download_filename}, ext={ext}, filename param={filename}")

    # Serve resized image when ?w= is specified
    if w is not None and ext in IMAGE_EXTS:
        cache_path = resize_and_cache_image(full_path, w, CACHE_DIR)
        if cache_path:
            return FileResponse(cache_path, media_type="image/webp", headers=headers, filename=download_filename)
        # Fallback to original on any processing error

    # Starlette FileResponse 自动设置 Accept-Ranges: bytes 并处理 Range 请求（206）
    # 无需手动设置，此处直接返回 FileResponse 即可支持视频断点播放

    return FileResponse(full_path, media_type=media_type, headers=headers, filename=download_filename)


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

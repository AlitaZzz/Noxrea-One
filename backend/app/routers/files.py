import uuid
import os
import hashlib

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, status, Query
from fastapi.responses import FileResponse

from app.schemas.common import UnifiedResponse
from app.deps import get_current_user
from app.config import settings

router = APIRouter(prefix="/api/files", tags=["files"])

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "uploads")
CACHE_DIR = os.path.join(UPLOAD_DIR, "_cache")

# Image extensions that support resize
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


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
    category: str = "",
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

    filename = f"{uuid.uuid4().hex}{ext}"
    target_dir = get_upload_dir(user.id, category)
    filepath = os.path.join(target_dir, filename)

    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)

    # URL: {user_id}/{category}/{filename}
    url_path = f"{user.id}/{category}/{filename}" if category else f"{user.id}/{filename}"
    url = f"{settings.PUBLIC_URL}/api/files/{url_path}"
    return UnifiedResponse(code=200, data={"url": url, "filename": filename}, msg="uploaded")


@router.get("/{filepath:path}")
async def get_file(
    filepath: str,
    w: int = Query(None, ge=1, le=4096, description="Resize image width in pixels"),
):
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
        # Use WebP for cache (smaller than JPEG, supports alpha)
        cache_ext = ".webp"
        cache_sub = os.path.dirname(filepath)
        cache_name = f"{os.path.splitext(os.path.basename(filepath))[0]}_w{w}{cache_ext}"
        cache_path = os.path.join(CACHE_DIR, cache_sub, cache_name)
        cache_media = "image/webp"

        if os.path.isfile(cache_path):
            return FileResponse(cache_path, media_type=cache_media, headers=headers)

        # Generate resized image
        try:
            from PIL import Image

            img = Image.open(full_path)
            orig_w, orig_h = img.size
            ratio = w / orig_w
            new_h = max(1, round(orig_h * ratio))
            img = img.resize((w, new_h), Image.LANCZOS)

            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            img.save(cache_path, "WEBP", quality=75, optimize=True)
            return FileResponse(cache_path, media_type=cache_media, headers=headers)
        except Exception:
            # Fallback to original on any processing error
            pass

    # For video, support range requests
    if ext in (".mp4", ".webm"):
        headers["Accept-Ranges"] = "bytes"

    return FileResponse(full_path, media_type=media_type, headers=headers)


@router.post("/capture-frame")
async def capture_frame(body: dict, user=Depends(get_current_user)):
    """Extract a frame from a video file. body: { url: str, time: float }"""
    import subprocess, uuid, os as _os
    video_url = body.get("url", "")
    seek_time = body.get("time", 0)

    if not video_url or "/api/files/" not in video_url:
        raise HTTPException(status_code=400, detail="Invalid video URL")

    rel = video_url.split("/api/files/")[-1]
    video_path = _os.path.join(UPLOAD_DIR, rel)
    if not _os.path.isfile(video_path):
        raise HTTPException(status_code=404, detail="Video not found")
    if not video_path.startswith(_os.path.join(UPLOAD_DIR, str(user.id))):
        raise HTTPException(status_code=403, detail="Access denied")

    # Generate output filename
    frame_name = f"{uuid.uuid4().hex}.png"
    out_dir = get_upload_dir(user.id, "frames")
    out_path = _os.path.join(out_dir, frame_name)

    # ffmpeg binary: backend/bin/ffmpeg (or ffmpeg.exe on Windows)
    bin_dir = _os.path.join(_os.path.dirname(__file__), "..", "..", "bin")
    ffmpeg = _os.path.join(bin_dir, "ffmpeg.exe" if _os.name == "nt" else "ffmpeg")

    try:
        subprocess.run(
            [ffmpeg, "-y", "-i", video_path, "-ss", str(seek_time),
             "-vframes", "1", out_path],
            check=True, capture_output=True, timeout=30,
        )
    except subprocess.CalledProcessError:
        raise HTTPException(status_code=500, detail="Frame extraction failed")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="ffmpeg not installed")

    url = f"{settings.PUBLIC_URL}/api/files/{user.id}/frames/{frame_name}"
    return UnifiedResponse(code=200, data={"url": url}, msg="frame captured")


@router.delete("/{filepath:path}")
async def delete_file(filepath: str, user=Depends(get_current_user)):
    full_path = os.path.join(UPLOAD_DIR, filepath)
    # Security: only allow deleting files under user's own directory
    if not full_path.startswith(os.path.join(UPLOAD_DIR, str(user.id))):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot delete other user's files")
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    os.remove(full_path)

    # Clean up cached resized versions
    base_name = os.path.splitext(os.path.basename(filepath))[0]
    cache_sub = os.path.dirname(filepath)
    cache_dir = os.path.join(CACHE_DIR, cache_sub)
    if os.path.isdir(cache_dir):
        for fname in os.listdir(cache_dir):
            if fname.startswith(base_name + "_w"):
                try:
                    os.remove(os.path.join(cache_dir, fname))
                except OSError:
                    pass

    return UnifiedResponse(code=200, msg="deleted")

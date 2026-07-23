"""
media.py — 图片/视频媒体处理服务。

封装 routers/files.py 中嵌入的 PIL 缩放、ffmpeg 裁帧、文件路径校验等业务逻辑。
"""

import logging
import os
import subprocess
import uuid
from pathlib import Path
from typing import Optional

from app.config import settings

logger = logging.getLogger(__name__)

# ── 配置 ──────────────────────────────────────────────────────────

# 最终 UPLOAD_DIR 由 settings 或默认路径决定
_DEFAULT_UPLOAD_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "uploads"
)
UPLOAD_DIR = str(getattr(settings, "UPLOAD_DIR", _DEFAULT_UPLOAD_DIR))

# 支持缩放的图片扩展名
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

# ── ffmpeg 路径查找 ──────────────────────────────────────────────


def get_ffmpeg_path() -> str:
    """查找 ffmpeg 可执行文件路径。"""
    bin_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "bin"
    )
    ffmpeg = os.path.join(
        bin_dir, "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    )
    return ffmpeg


# ── 文件路径校验 ──────────────────────────────────────────────────


def validate_user_file(filepath: str, user_id: int) -> str:
    """
    校验 filepath 是否指向 uploads/{user_id}/ 下的合法文件。

    返回完整的绝对路径，或抛出 HTTPException 风格的异常。
    注意：此函数不进行数据库查询，仅做文件系统路径校验。

    Raises:
        FileNotFoundError: 文件不存在
        PermissionError: 路径不属于当前用户（403）
        ValueError: URL 格式无效（400）
    """
    full_path = os.path.join(UPLOAD_DIR, filepath)

    if not os.path.isfile(full_path):
        raise FileNotFoundError(f"File not found: {filepath}")

    user_dir = os.path.join(UPLOAD_DIR, str(user_id))
    if not full_path.startswith(user_dir):
        raise PermissionError(
            f"Access denied: {filepath} is not in user {user_id}'s directory"
        )

    return full_path


# ── 图片缩放 + 缓存 ─────────────────────────────────────────────


def resize_and_cache_image(
    src_path: str,
    width: int,
    cache_dir: str,
) -> Optional[str]:
    """
    将图片缩放到指定宽度（等比），保存为 WebP 到缓存目录。

    Args:
        src_path: 源文件路径
        width: 目标宽度（像素）
        cache_dir: 缓存根目录

    Returns:
        缓存文件路径（如果已存在或生成成功），
        None（如果处理失败，由调用方 fallback 到原图）
    """
    ext = os.path.splitext(src_path)[1].lower()
    if ext not in IMAGE_EXTS:
        return None

    cache_ext = ".webp"
    src_dir = os.path.dirname(src_path)
    src_base = os.path.splitext(os.path.basename(src_path))[0]
    cache_name = f"{src_base}_w{width}{cache_ext}"

    # 计算相对于 UPLOAD_DIR 的子路径，用于缓存目录结构
    rel_dir = os.path.relpath(src_dir, UPLOAD_DIR) if src_dir.startswith(UPLOAD_DIR) else ""
    cache_path = os.path.join(cache_dir, rel_dir, cache_name)

    # 缓存命中
    if os.path.isfile(cache_path):
        logger.debug(f"Cache hit: {cache_path}")
        return cache_path

    # 生成缓存
    try:
        from PIL import Image

        img = Image.open(src_path)
        orig_w, orig_h = img.size
        ratio = width / orig_w
        new_h = max(1, round(orig_h * ratio))
        img = img.resize((width, new_h), Image.LANCZOS)

        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        img.save(cache_path, "WEBP", quality=75, optimize=True)
        logger.debug(f"image cached path={cache_path}")
        return cache_path
    except Exception:
        logger.warning(f"image resize failed src={src_path}", exc_info=True)
        return None


# ── 视频裁帧 ──────────────────────────────────────────────────────


def extract_video_frame(
    video_path: str,
    timestamp: float,
    output_dir: str,
    ffmpeg_bin: Optional[str] = None,
    timeout: int = 30,
) -> Optional[str]:
    """
    使用 ffmpeg 从视频中提取一帧。

    Args:
        video_path: 视频文件路径
        timestamp: 提取时间点（秒）
        output_dir: 输出目录
        ffmpeg_bin: ffmpeg 可执行文件路径，None 自动查找
        timeout: 子进程超时秒数

    Returns:
        输出文件路径（成功时），
        None（失败时，由调用方负责报错）

    Raises:
        FileNotFoundError: ffmpeg 未找到
        subprocess.TimeoutExpired: 处理超时
        RuntimeError: ffmpeg 进程失败
    """
    if ffmpeg_bin is None:
        ffmpeg_bin = get_ffmpeg_path()

    if not os.path.isfile(ffmpeg_bin):
        logger.error(
            f"ffmpeg not found at {ffmpeg_bin}; install ffmpeg and add it to PATH, "
            f"or place it under backend/bin/, otherwise video thumbnails/frame capture cannot be generated"
        )
        raise FileNotFoundError(f"ffmpeg not found at {ffmpeg_bin}")

    frame_name = f"{uuid.uuid4().hex}.png"
    out_path = os.path.join(output_dir, frame_name)
    os.makedirs(output_dir, exist_ok=True)

    try:
        subprocess.run(
            [
                ffmpeg_bin, "-y", "-i", video_path,
                "-ss", str(timestamp),
                "-vframes", "1",
                out_path,
            ],
            check=True,
            capture_output=True,
            timeout=timeout,
        )
        logger.debug(f"frame extracted path={out_path}")
        return out_path
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
        logger.error(f"ffmpeg failed src={video_path} err={stderr[:120]}")
        raise RuntimeError(f"Frame extraction failed: {stderr[:200]}")
    except subprocess.TimeoutExpired:
        logger.error(f"ffmpeg timeout src={video_path} timeout={timeout}s")
        raise

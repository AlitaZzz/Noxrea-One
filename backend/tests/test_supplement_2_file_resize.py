"""
补充-2: 文件访问与缩放缓存 (?w= 参数)

核心验证：
  - GET /api/files/{path} → 正常返回文件
  - GET /api/files/{path}?w=200 → 返回缩放的 WebP 图片并缓存到 _cache 目录
  - 重复请求 → 返回缓存内容（不走 PIL 重处理）
  - w 参数超出范围 (1-4096) → 应被拒绝
  - 非图片格式（mp4）忽略 w 参数
"""

import hashlib
import os
import pytest
from PIL import Image
from io import BytesIO
import app.routers.files as _files_mod

UPLOAD_PATH = _files_mod.UPLOAD_DIR
CACHE_PATH = _files_mod.CACHE_DIR


def _ensure_upload_dir(user_id: int, subdir: str = "") -> str:
    target = os.path.join(UPLOAD_PATH, str(user_id), subdir)
    os.makedirs(target, exist_ok=True)
    return target


def _upload_test_image(async_client, content: bytes, filename: str = "test.png") -> str:
    """Helper: upload an image and return its URL."""
    import pytest
    # Not an async function; run via the test
    raise NotImplementedError("Use from within test")


class TestFileResizeCache:

    # ── 补充-2.a: 正常文件访问 ──────────────────────────────────

    async def test_get_file_returns_content(self, async_client):
        """上传后 GET 文件路径 → 200，正确 Content-Type."""
        content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20  # minimally valid-ish
        # Actually upload a real PNG via the API
        from conftest import sample_png_bytes
        png_bytes = sample_png_bytes()

        r_up = await async_client.post(
            "/api/files/upload?category=images",
            files={"file": ("test.png", png_bytes, "image/png")},
        )
        assert r_up.status_code == 200
        url = r_up.json()["data"]["url"]  # e.g. http://testserver/api/files/1/aa/aa...aa.png

        # Extract filepath from URL
        file_path = url.replace("http://testserver", "")

        r_get = await async_client.get(file_path)
        assert r_get.status_code == 200
        assert r_get.headers.get("content-type") == "image/png"

    # ── 补充-2.b: 缩放请求 → 返回 WebP ──────────────────────────

    async def test_resize_with_w_returns_webp(self, async_client):
        """?w=200 应返回缩放后的 image/webp."""
        from conftest import sample_png_bytes
        png = sample_png_bytes()

        r_up = await async_client.post(
            "/api/files/upload?category=images",
            files={"file": ("img.png", png, "image/png")},
        )
        file_path = r_up.json()["data"]["url"].replace("http://testserver", "")

        r_small = await async_client.get(file_path, params={"w": 200})
        assert r_small.status_code == 200, f"Resize failed: {r_small.text}"
        assert r_small.headers.get("content-type") == "image/webp"

        # 验证内容是有效的 WebP（尺寸应为 200x?）
        img = Image.open(BytesIO(r_small.content))
        assert img.width == 200, f"Expected width 200, got {img.width}"
        assert img.format == "WEBP"

    # ── 补充-2.c: 缓存命中 ──────────────────────────────────────

    async def test_resize_cache_hit(self, async_client):
        """第二次相同 w 请求应命中缓存，不走 PIL."""
        from conftest import sample_png_bytes
        png = sample_png_bytes()

        r_up = await async_client.post(
            "/api/files/upload?category=images",
            files={"file": ("cached.png", png, "image/png")},
        )
        file_path = r_up.json()["data"]["url"].replace("http://testserver", "")

        # 第一次请求 → 生成缓存
        r1 = await async_client.get(file_path, params={"w": 100})
        assert r1.status_code == 200

        # 第二次请求 → 缓存命中
        r2 = await async_client.get(file_path, params={"w": 100})
        assert r2.status_code == 200

        # 验证内容一致（缓存与生成结果相同）
        img1 = Image.open(BytesIO(r1.content))
        img2 = Image.open(BytesIO(r2.content))
        assert img1.width == img2.width == 100

        # 验证缓存文件存在
        file_hash = hashlib.sha256(png).hexdigest()
        cache_subdir = os.path.join(CACHE_PATH, str(1), file_hash[:2])
        assert os.path.isdir(cache_subdir), "cache directory not created"
        cache_files = [f for f in os.listdir(cache_subdir) if "w100" in f]
        assert len(cache_files) >= 1, "cached file not found"

    # ── 补充-2.d: w 参数越界 ────────────────────────────────────

    @pytest.mark.parametrize("bad_w", [0, 5000, -1])
    async def test_invalid_w_param(self, async_client, bad_w):
        """w 参数不在 [1, 4096] 范围时，API 应拒绝."""
        r = await async_client.get("/api/files/1/aa/test.png", params={"w": bad_w})
        assert r.status_code == 422, f"Expected 422 for w={bad_w}, got {r.status_code}"

    # ── 补充-2.e: 视频文件忽略 w 参数 ───────────────────────────

    async def test_video_ignores_w(self, async_client):
        """非图片文件（mp4）带 w 参数时忽略缩放."""
        content = b"\x00\x00\x00\x20ftypmp42"
        r_up = await async_client.post(
            "/api/files/upload?category=videos",
            files={"file": ("clip.mp4", content, "video/mp4")},
        )
        assert r_up.status_code == 200
        file_path = r_up.json()["data"]["url"].replace("http://testserver", "")

        r = await async_client.get(file_path, params={"w": 200})
        assert r.status_code == 200
        # 视频应该保持原始 content-type，不是 image/webp
        assert r.headers.get("content-type") == "video/mp4", \
            f"Expected video/mp4, got {r.headers.get('content-type')}"

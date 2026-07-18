"""
P0-1: CAS 文件上传去重（同一用户同一内容）

核心验证：
  - 同一用户两次上传同一文件 → 第二个请求不写盘、不新建 file_objects 记录
  - 不同 category 上传同一内容 → 仍然去重（category 仅记录 source 字段，不影响去重）
  - 两次返回的 url 相同
"""

import os
import hashlib
import pytest


class TestCasFileUploadDedup:

    UPLOAD_PATH = os.path.join(os.path.dirname(__file__), "fixtures", ".test_uploads")

    async def _count_file_objects(self, db) -> int:
        from sqlalchemy import text as _sql
        r = await db.execute(_sql("SELECT COUNT(*) FROM file_objects"))
        return r.scalar()

    async def _count_physical_files(self, user_id: int, file_hash: str) -> int:
        """Count how many physical files exist on disk for a given hash."""
        sub = file_hash[:2]
        dirpath = os.path.join(self.UPLOAD_PATH, str(user_id), sub)
        if not os.path.isdir(dirpath):
            return 0
        return len([f for f in os.listdir(dirpath) if f.startswith(file_hash)])

    # ── P0-1.a: 同一 PNG 文件上传两次 ──────────────────────────

    async def test_upload_same_png_twice(self, async_client, db):
        """两次上传同一 PNG 文件，第二次返回相同 url 且不新建记录."""
        from conftest import sample_png_bytes

        content = sample_png_bytes()
        file_hash = hashlib.sha256(content).hexdigest()

        # 第一次上传
        r1 = await async_client.post(
            "/api/files/upload?category=images",
            files={"file": ("test.png", content, "image/png")},
        )
        assert r1.status_code == 200, f"First upload failed: {r1.text}"
        data1 = r1.json()
        url1 = data1["data"]["url"]

        # 第二次上传（完全相同的文件）
        r2 = await async_client.post(
            "/api/files/upload?category=images",
            files={"file": ("test.png", content, "image/png")},
        )
        assert r2.status_code == 200, f"Second upload failed: {r2.text}"
        data2 = r2.json()
        url2 = data2["data"]["url"]

        # URL 一致
        assert url1 == url2, f"URL mismatch: {url1} vs {url2}"

        # file_objects 只有一条记录
        count = await self._count_file_objects(db)
        assert count == 1, f"Expected 1 file_object, got {count}"

        # 物理文件只存在一份
        from conftest import auth_token
        user_id = 1  # admin
        phys = await self._count_physical_files(user_id, file_hash)
        assert phys == 1, f"Expected 1 physical file, got {phys}"

    # ── P0-1.b: 不同 category 上传同一文件 → 仍然去重 ──────────

    async def test_upload_same_file_different_categories(self, async_client, db):
        """images / assets / generated 上传同一文件 → 去重."""
        content = b"dedup-category-test-content-xyz"
        file_hash = hashlib.sha256(content).hexdigest()

        for cat in ("images", "assets", "generated"):
            r = await async_client.post(
                f"/api/files/upload?category={cat}",
                files={"file": ("img.png", content, "image/png")},
            )
            assert r.status_code == 200, f"Upload with category={cat} failed: {r.text}"

        count = await self._count_file_objects(db)
        assert count == 1, f"Expected 1 file_object across categories, got {count}"

    # ── P0-1.c: 不同的文件 → 不重复 ─────────────────────────────

    async def test_upload_different_files(self, async_client, db):
        """不同内容不触发去重."""
        content_a = b"file-a-content-111"
        content_b = b"file-b-content-222"

        r1 = await async_client.post(
            "/api/files/upload?category=images",
            files={"file": ("a.png", content_a, "image/png")},
        )
        assert r1.status_code == 200

        r2 = await async_client.post(
            "/api/files/upload?category=images",
            files={"file": ("b.png", content_b, "image/png")},
        )
        assert r2.status_code == 200

        # 两条记录
        count = await self._count_file_objects(db)
        assert count == 2, f"Expected 2 file_objects, got {count}"

        # 各自的 hash 不同
        url1 = r1.json()["data"]["url"]
        url2 = r2.json()["data"]["url"]
        assert url1 != url2

    # ── P0-1.d: 视频文件上传 ────────────────────────────────────

    async def test_upload_video_dedup(self, async_client, db):
        """视频文件同样走 SHA256 CAS 去重."""
        content = b"\x00\x00\x00\x20ftypmp42FAKE"
        file_hash = hashlib.sha256(content).hexdigest()

        r1 = await async_client.post(
            "/api/files/upload?category=videos",
            files={"file": ("clip.mp4", content, "video/mp4")},
        )
        assert r1.status_code == 200

        r2 = await async_client.post(
            "/api/files/upload?category=videos",
            files={"file": ("clip.mp4", content, "video/mp4")},
        )
        assert r2.status_code == 200

        count = await self._count_file_objects(db)
        assert count == 1, f"Expected 1 file_object for deduped video, got {count}"
        assert r1.json()["data"]["url"] == r2.json()["data"]["url"]

"""
补充-1: 不同用户上传同一文件 → 隔离

核心验证：
  - UserA 上传 → file_objects(UserA, hash) 创建
  - UserB 上传同一内容 → file_objects(UserB, hash) 创建（独立记录）
  - (user_id, hash) 为主键 → 天然支持用户级隔离
  - 物理文件路径包含 user_id → 各自目录互不干扰
"""

import hashlib
import os
import pytest
from sqlalchemy import text as _sql
from httpx import ASGITransport, AsyncClient

from app.main import app as _app
from app.deps import get_db
import app.routers.files as _files_mod
from conftest import sample_png_bytes

UPLOAD_PATH = _files_mod.UPLOAD_DIR


class TestCrossUserDedup:

    SAMPLE = sample_png_bytes()
    FILE_HASH = hashlib.sha256(SAMPLE).hexdigest()

    async def _ensure_user(self, db, username: str):
        """Ensure a user exists, return dict."""
        from app.services.auth import hash_password
        await db.execute(
            _sql("INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (:u, :p, 'user')"),
            {"u": username, "p": hash_password(username + "_pass")},
        )
        await db.commit()
        r = await db.execute(
            _sql("SELECT id, username, password_hash, role FROM users WHERE username = :u"),
            {"u": username},
        )
        row = r.fetchone()
        return {"id": row[0], "username": row[1], "pw": row[2], "role": row[3]}

    @staticmethod
    async def _count_objects(db, user_id: int, file_hash: str) -> int:
        r = await db.execute(
            _sql("SELECT COUNT(*) FROM file_objects WHERE user_id = :uid AND hash = :h"),
            {"uid": user_id, "h": file_hash},
        )
        return r.scalar()

    async def test_user_isolation_via_db(self, db):
        """(user_id, hash) 复合主键天然允许不同用户的相同 hash 共存."""
        u1 = await self._ensure_user(db, "iso_user_a")
        u2 = await self._ensure_user(db, "iso_user_b")

        for uid in (u1["id"], u2["id"]):
            await db.execute(
                _sql("""INSERT OR IGNORE INTO file_objects (user_id, hash, size, mime_type, ext, source)
                         VALUES (:uid, :h, 10, 'image/png', '.png', 'test')"""),
                {"uid": uid, "h": self.FILE_HASH},
            )
        await db.commit()

        assert await self._count_objects(db, u1["id"], self.FILE_HASH) == 1
        assert await self._count_objects(db, u2["id"], self.FILE_HASH) == 1

    async def test_upload_as_different_users(self, db):
        """通过 API 上传：不同用户上传同一内容，各自创建独立记录.

        策略：只 override get_db（指向测试内存数据库），
        get_current_user 使用真实 JWT 鉴权，不同 token 解析出不同用户。
        """
        from app.services.auth import create_access_token

        u_a = await self._ensure_user(db, "multi_user_a")
        u_b = await self._ensure_user(db, "multi_user_b")
        token_a = create_access_token({"sub": str(u_a["id"])})
        token_b = create_access_token({"sub": str(u_b["id"])})

        # 只 override get_db（指向测试的 in-memory 数据库）
        # get_current_user 使用真实 JWT 鉴权，不 override
        async def _db_override():
            yield db

        _app.dependency_overrides[get_db] = _db_override
        try:
            transport = ASGITransport(app=_app)
            async with AsyncClient(transport=transport, base_url="http://testserver") as client:
                # 用户 A 上传
                r_a = await client.post(
                    "/api/files/upload?category=images",
                    files={"file": ("img.png", self.SAMPLE, "image/png")},
                    headers={"Authorization": f"Bearer {token_a}"},
                )
                assert r_a.status_code == 200, f"User A upload failed: {r_a.text}"
                url_a = r_a.json()["data"]["url"]

                # 用户 B 上传同一文件
                r_b = await client.post(
                    "/api/files/upload?category=images",
                    files={"file": ("img.png", self.SAMPLE, "image/png")},
                    headers={"Authorization": f"Bearer {token_b}"},
                )
                assert r_b.status_code == 200, f"User B upload failed: {r_b.text}"
                url_b = r_b.json()["data"]["url"]
        finally:
            _app.dependency_overrides.clear()

        # URL 路径不同（user_id 不同）
        assert str(u_a["id"]) in url_a, f"URL {url_a} should contain user_id {u_a['id']}"
        assert str(u_b["id"]) in url_b, f"URL {url_b} should contain user_id {u_b['id']}"
        assert url_a != url_b

        # 各自有一条记录
        assert await self._count_objects(db, u_a["id"], self.FILE_HASH) == 1
        assert await self._count_objects(db, u_b["id"], self.FILE_HASH) == 1

        # 物理文件（验证目录隔离）
        for uid in (u_a["id"], u_b["id"]):
            sub = self.FILE_HASH[:2]
            dirpath = os.path.join(UPLOAD_PATH, str(uid), sub)
            assert os.path.isdir(dirpath), f"User {uid} upload dir missing"

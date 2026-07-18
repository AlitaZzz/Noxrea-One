"""
P0-3: 资产库引用维护

核心验证：
  - 创建 asset（含 sourceUrl）→ file_reference 增加
  - 删除 asset → file_reference 清除
  - 批量创建 assets → 所有引用正确建立
  - sourceUrl 不是 CAS 路径的 asset 不创建 file_reference
"""

import hashlib
import pytest
from sqlalchemy import text as _sql


TEST_HASH_A = "d" * 64
TEST_HASH_B = "e" * 64


def _make_file_url(user_id: int, hash_val: str, ext: str = ".png") -> str:
    return f"http://testserver/api/files/{user_id}/{hash_val[:2]}/{hash_val}{ext}"


async def _ensure_file_object(db, user_id: int, hash_val: str):
    await db.execute(
        _sql("""INSERT OR IGNORE INTO file_objects (user_id, hash, size, mime_type, ext, source)
                 VALUES (:uid, :h, 100, 'image/png', '.png', 'test')"""),
        {"uid": user_id, "h": hash_val},
    )
    await db.commit()


class TestAssetReferences:

    # ── P0-3.a: 创建 asset → 新增 file_reference ────────────────

    async def test_create_asset_adds_ref(self, async_client, db, test_user):
        """创建 asset（含 sourceUrl）→ file_references 增加对应记录."""
        uid = test_user["id"]
        url = _make_file_url(uid, TEST_HASH_A)
        await _ensure_file_object(db, uid, TEST_HASH_A)

        r = await async_client.post("/api/assets/items", json={
            "name": "test-asset",
            "type": "image",
            "space_key": "default",
            "extra_data": {"sourceUrl": url},
        })
        assert r.status_code == 200, f"Create asset failed: {r.text}"
        asset_id = r.json()["data"]["id"]

        rows = await db.execute(
            _sql("SELECT file_hash, ref_type FROM file_references WHERE ref_type = 'asset' AND ref_id = :aid"),
            {"aid": asset_id},
        )
        refs = rows.fetchall()
        assert len(refs) == 1
        assert refs[0][0] == TEST_HASH_A

    # ── P0-3.b: 删除 asset → 清理 file_reference ────────────────

    async def test_delete_asset_removes_ref(self, async_client, db, test_user):
        """删除 asset → 对应 file_reference 被删除."""
        uid = test_user["id"]
        url = _make_file_url(uid, TEST_HASH_A)
        await _ensure_file_object(db, uid, TEST_HASH_A)

        r = await async_client.post("/api/assets/items", json={
            "name": "del-asset", "type": "image", "space_key": "default",
            "extra_data": {"sourceUrl": url},
        })
        asset_id = r.json()["data"]["id"]

        # 删除
        r2 = await async_client.delete(f"/api/assets/items/{asset_id}")
        assert r2.status_code == 200

        rows = await db.execute(
            _sql("SELECT COUNT(*) FROM file_references WHERE ref_type = 'asset' AND ref_id = :aid"),
            {"aid": asset_id},
        )
        assert rows.scalar() == 0, "file_reference should be removed after asset deletion"

    # ── P0-3.c: 批量创建 → 所有引用正确 ─────────────────────────

    async def test_batch_create_assets_refs(self, async_client, db, test_user):
        """批量创建 assets → 每个 asset 的引用都正确建立."""
        uid = test_user["id"]
        url_a = _make_file_url(uid, TEST_HASH_A)
        url_b = _make_file_url(uid, TEST_HASH_B)
        await _ensure_file_object(db, uid, TEST_HASH_A)
        await _ensure_file_object(db, uid, TEST_HASH_B)

        r = await async_client.post("/api/assets/items/batch", json=[
            {"name": "batch1", "type": "image", "space_key": "default",
             "extra_data": {"sourceUrl": url_a}},
            {"name": "batch2", "type": "image", "space_key": "default",
             "extra_data": {"sourceUrl": url_b}},
        ])
        assert r.status_code == 200, f"Batch create failed: {r.text}"
        assets = r.json()["data"]
        assert len(assets) == 2

        for asset, expected_hash in zip(assets, [TEST_HASH_A, TEST_HASH_B]):
            rows = await db.execute(
                _sql("SELECT file_hash FROM file_references WHERE ref_type = 'asset' AND ref_id = :aid"),
                {"aid": asset["id"]},
            )
            refs = rows.fetchall()
            assert len(refs) == 1
            assert refs[0][0] == expected_hash

    # ── P0-3.d: 非 CAS 路径不创建引用 ───────────────────────────

    @pytest.mark.parametrize("bad_url", [
        "http://example.com/external.png",
        "/api/files/1/xx/short.png",           # hash 不够 64 位
        None,
    ])
    async def test_non_cas_url_no_ref(self, async_client, db, test_user, bad_url):
        """非 CAS url 的 sourceUrl → 不创建 file_reference."""
        body = {
            "name": "external-img",
            "type": "image",
            "space_key": "default",
        }
        if bad_url is not None:
            body["extra_data"] = {"sourceUrl": bad_url}

        r = await async_client.post("/api/assets/items", json=body)
        assert r.status_code == 200
        asset_id = r.json()["data"]["id"]

        rows = await db.execute(
            _sql("SELECT COUNT(*) FROM file_references WHERE ref_type = 'asset' AND ref_id = :aid"),
            {"aid": asset_id},
        )
        assert rows.scalar() == 0, f"non-CAS url '{bad_url}' should not create ref"

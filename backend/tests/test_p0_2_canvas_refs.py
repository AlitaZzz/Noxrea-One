"""
P0-2: 画布 fingerprint 与 file_references 同步

核心验证：
  - needRefRecalc=true 时，_recalc_project_refs 正确添加/删除 file_references
  - 多个节点引用同一文件 → 只产生一条 file_reference（去重）
  - needRefRecalc=false 时不触发引用重算
  - image-group-node 的 images[].url 也被正确收集
"""

import hashlib
import pytest
from sqlalchemy import text as _sql


TEST_HASH_1 = "a" * 64   # 模拟 /api/files/1/aa/aaaa...png 的 hash
TEST_HASH_2 = "b" * 64
TEST_HASH_3 = "c" * 64


async def _ensure_file_object(db, user_id: int, hash_val: str, ext: str = ".png"):
    """确保 file_objects 中存在此 hash（不然 FK/file_reference 的逻辑可能报错）."""
    await db.execute(
        _sql("""INSERT OR IGNORE INTO file_objects (user_id, hash, size, mime_type, ext, source)
                 VALUES (:uid, :h, 100, 'image/png', :ext, 'test')"""),
        {"uid": user_id, "h": hash_val, "ext": ext},
    )
    await db.commit()


def _make_file_url(user_id: int, hash_val: str, ext: str = ".png") -> str:
    """生成符合 /api/files/{user_id}/{hash[:2]}/{hash}{ext} 格式的 URL."""
    return f"http://testserver/api/files/{user_id}/{hash_val[:2]}/{hash_val}{ext}"


def _canvas_payload(nodes: list[dict]) -> dict:
    """构造 PUT /api/canvas/projects/{id} 的 body."""
    return {
        "canvas_data": {"nodes": nodes, "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}},
        "needRefRecalc": True,
    }


class TestCanvasFingerprintAndRefs:

    # ── P0-2.a: 添加节点 → 新增 file_reference ──────────────────

    async def test_add_node_creates_reference(self, async_client, db, test_user):
        """带 src 的画布节点保存后，file_references 中新增记录."""
        uid = test_user["id"]
        url1 = _make_file_url(uid, TEST_HASH_1)
        await _ensure_file_object(db, uid, TEST_HASH_1)

        # 创建项目
        r = await async_client.post(
            "/api/canvas/projects",
            json={"name": "test-proj", "canvas_data": {"nodes": [], "edges": []}},
        )
        assert r.status_code == 200
        pid = r.json()["data"]["id"]

        # 保存画布（带一个图片节点）
        nodes = [{"id": "n1", "type": "image-node", "data": {"src": url1}}]
        r2 = await async_client.put(f"/api/canvas/projects/{pid}", json=_canvas_payload(nodes))
        assert r2.status_code == 200, f"Save failed: {r2.text}"

        # 验证 file_references
        rows = await db.execute(
            _sql("SELECT file_hash, ref_type, ref_id FROM file_references WHERE ref_type = 'canvas_project' AND ref_id = :pid"),
            {"pid": pid},
        )
        refs = rows.fetchall()
        assert len(refs) == 1, f"Expected 1 ref, got {len(refs)}"
        assert refs[0][0] == TEST_HASH_1
        assert refs[0][2] == pid

    # ── P0-2.b: 删除节点 → 清理旧的 file_reference ─────────────

    async def test_remove_node_cleans_reference(self, async_client, db, test_user):
        """节点被删除后，对应的 file_reference 被清理."""
        uid = test_user["id"]
        url1 = _make_file_url(uid, TEST_HASH_1)
        url2 = _make_file_url(uid, TEST_HASH_2)
        await _ensure_file_object(db, uid, TEST_HASH_1)
        await _ensure_file_object(db, uid, TEST_HASH_2)

        r = await async_client.post(
            "/api/canvas/projects",
            json={"name": "ref-clean", "canvas_data": {"nodes": [], "edges": []}},
        )
        pid = r.json()["data"]["id"]

        # 先存两个节点
        nodes = [
            {"id": "n1", "type": "image-node", "data": {"src": url1}},
            {"id": "n2", "type": "image-node", "data": {"src": url2}},
        ]
        await async_client.put(f"/api/canvas/projects/{pid}", json=_canvas_payload(nodes))

        # 保存（只保留一个节点）
        nodes2 = [{"id": "n1", "type": "image-node", "data": {"src": url1}}]
        await async_client.put(f"/api/canvas/projects/{pid}", json=_canvas_payload(nodes2))

        rows = await db.execute(
            _sql("SELECT file_hash FROM file_references WHERE ref_type = 'canvas_project' AND ref_id = :pid"),
            {"pid": pid},
        )
        hashes = {r[0] for r in rows.fetchall()}
        assert TEST_HASH_1 in hashes, "remaining hash should still be present"
        assert TEST_HASH_2 not in hashes, "removed hash should be cleaned up"

    # ── P0-2.c: 多节点引用同一文件 → 只一条引用 ────────────────

    async def test_duplicate_hash_dedup(self, async_client, db, test_user):
        """两个节点引用同一个 hash → file_references 只保存一条."""
        uid = test_user["id"]
        url1 = _make_file_url(uid, TEST_HASH_1)
        await _ensure_file_object(db, uid, TEST_HASH_1)

        r = await async_client.post(
            "/api/canvas/projects",
            json={"name": "dedup-ref", "canvas_data": {"nodes": [], "edges": []}},
        )
        pid = r.json()["data"]["id"]

        nodes = [
            {"id": "n1", "type": "image-node", "data": {"src": url1}},
            {"id": "n2", "type": "image-node", "data": {"src": url1}},
        ]
        await async_client.put(f"/api/canvas/projects/{pid}", json=_canvas_payload(nodes))

        rows = await db.execute(
            _sql("SELECT COUNT(*) FROM file_references WHERE ref_type = 'canvas_project' AND ref_id = :pid"),
            {"pid": pid},
        )
        count = rows.scalar()
        assert count == 1, f"Expected 1 ref (dedup), got {count}"

    # ── P0-2.d: image-group-node 的 images[].url ────────────────

    async def test_image_group_node_refs(self, async_client, db, test_user):
        """image-group-node 的 images[].url 也被 _recalc_project_refs 收集."""
        uid = test_user["id"]
        url3 = _make_file_url(uid, TEST_HASH_3)
        await _ensure_file_object(db, uid, TEST_HASH_3)

        r = await async_client.post(
            "/api/canvas/projects",
            json={"name": "group-ref", "canvas_data": {"nodes": [], "edges": []}},
        )
        pid = r.json()["data"]["id"]

        nodes = [{
            "id": "g1", "type": "image-group-node",
            "data": {"images": [{"url": url3}]},
        }]
        await async_client.put(f"/api/canvas/projects/{pid}", json=_canvas_payload(nodes))

        rows = await db.execute(
            _sql("SELECT file_hash FROM file_references WHERE ref_type = 'canvas_project' AND ref_id = :pid"),
            {"pid": pid},
        )
        hashes = {r[0] for r in rows.fetchall()}
        assert TEST_HASH_3 in hashes, "image-group-node url not collected"

    # ── P0-2.e: needRefRecalc=false 不触发重算 ──────────────────

    async def test_no_recalc_without_flag(self, async_client, db, test_user):
        """needRefRecalc=false 或不传时，不触发引用重算."""
        uid = test_user["id"]
        url1 = _make_file_url(uid, TEST_HASH_1)
        await _ensure_file_object(db, uid, TEST_HASH_1)

        r = await async_client.post(
            "/api/canvas/projects",
            json={"name": "no-recalc", "canvas_data": {"nodes": [], "edges": []}},
        )
        pid = r.json()["data"]["id"]

        payload = {
            "canvas_data": {"nodes": [{"id": "n1", "type": "image-node", "data": {"src": url1}}], "edges": []},
            # needRefRecalc 不传 → 默认 false
        }
        await async_client.put(f"/api/canvas/projects/{pid}", json=payload)

        rows = await db.execute(
            _sql("SELECT COUNT(*) FROM file_references WHERE ref_type = 'canvas_project' AND ref_id = :pid"),
            {"pid": pid},
        )
        assert rows.scalar() == 0, "needRefRecalc=false should not create refs"

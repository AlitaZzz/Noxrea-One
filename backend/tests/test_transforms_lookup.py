"""
lookup transform 测试。

覆盖：
- 单字段查表
- composite 多字段联合查表
- table 值为 list 时取第一个
- 查不到返回原值
"""

from app.services.request_builder.transforms import apply_transforms


# ── 单字段查表 ─────────────────────────────────────────────────

def test_lookup_single_field():
    """单字段查表：值在 table 中找到则替换。"""
    body = {"resolution": "1K"}
    transforms = {
        "resolution": {
            "type": "lookup",
            "table": {"1K": "1024x1024", "2K": "2048x2048"}
        }
    }
    result, consumed = apply_transforms(body, transforms)
    assert result["resolution"] == "1024x1024"
    assert consumed == set()


def test_lookup_single_field_not_found():
    """单字段查表：值不在 table 中则保留原值。"""
    body = {"resolution": "8K"}
    transforms = {
        "resolution": {
            "type": "lookup",
            "table": {"1K": "1024x1024"}
        }
    }
    result, consumed = apply_transforms(body, transforms)
    assert result["resolution"] == "8K"
    assert consumed == set()


# ── composite 多字段查表 ──────────────────────────────────────

def test_lookup_composite():
    """composite 多字段联合查表。"""
    body = {"ratio": "9:16", "resolution": "1K"}
    transforms = {
        "ratio": {
            "type": "lookup",
            "composite": ["ratio", "resolution"],
            "table": {
                "9:16|1K": "864x1536",
                "9:16|2K": "1152x2048",
                "1:1|1K": "1024x1024"
            }
        }
    }
    result, consumed = apply_transforms(body, transforms)
    assert result["ratio"] == "864x1536"
    # resolution 被标记为已消费
    assert "resolution" in consumed


def test_lookup_composite_not_found():
    """composite 查表：key 不在 table 中则保留原值。"""
    body = {"ratio": "3:1", "resolution": "8K"}
    transforms = {
        "ratio": {
            "type": "lookup",
            "composite": ["ratio", "resolution"],
            "table": {"9:16|1K": "864x1536"}
        }
    }
    result, consumed = apply_transforms(body, transforms)
    assert result["ratio"] == "3:1"
    assert "resolution" in consumed


# ── table 值为 list ──────────────────────────────────────────

def test_lookup_table_list_value():
    """table 值为 list 时取第一个元素。"""
    body = {"ratio": "1:1", "resolution": "1K"}
    transforms = {
        "ratio": {
            "type": "lookup",
            "composite": ["ratio", "resolution"],
            "table": {
                "1:1|1K": ["1024x1024", "1254x1254"]
            }
        }
    }
    result, consumed = apply_transforms(body, transforms)
    assert result["ratio"] == "1024x1024"
    assert "resolution" in consumed


# ── gpt-image-2 完整查表 ───────────────────────────────────────

def test_lookup_gpt_image_2_full():
    """模拟 gpt-image-2 完整查表：9:16|1K -> 864x1536。"""
    body = {"ratio": "9:16", "resolution": "1K", "quality": "high", "n": 1}
    transforms = {
        "ratio": {
            "type": "lookup",
            "composite": ["ratio", "resolution"],
            "table": {
                "1:1|1K": ["1024x1024", "1254x1254"],
                "9:16|1K": ["864x1536", "941x1672"],
                "16:9|1K": ["1536x864", "1672x941"],
            }
        }
    }
    result, consumed = apply_transforms(body, transforms)
    assert result["ratio"] == "864x1536"
    assert "resolution" in consumed
    assert result["quality"] == "high"
    assert result["n"] == 1


# ── nanobanana 无 transforms ──────────────────────────────────

def test_no_transforms():
    """无 transforms 时 body 不变。"""
    body = {"ratio": "16:9", "quality": "auto"}
    result, consumed = apply_transforms(body, {})
    assert result == body
    assert consumed == set()


def test_empty_transforms():
    """transforms 为空 dict 时 body 不变。"""
    body = {"ratio": "16:9", "quality": "auto"}
    result, consumed = apply_transforms(body, {})
    assert result == body
    assert consumed == set()

"""
engine auto-clean 测试。

覆盖：
- 删内部字段（capability）
- 删 None 值
- 删 composite 已消费字段
- transforms -> auto-clean -> mapping -> patch 完整链路
"""

from app.schemas.channel_config import ChannelConfig, RequestConfig
from app.services.request_builder import build


# ── 删内部字段 ─────────────────────────────────────────────────

def test_autoclean_removes_internal_fields():
    """auto-clean 删除 capability 内部字段。"""
    internal = {"model": "m", "prompt": "p", "capability": "image"}
    cfg = ChannelConfig()
    result = build(internal, cfg, "image", model_name="test-model")
    assert "capability" not in result
    assert result["model"] == "m"
    assert result["prompt"] == "p"


# ── 删 None 值 ────────────────────────────────────────────────

def test_autoclean_removes_none_values():
    """auto-clean 删除 None 值字段。"""
    internal = {
        "model": "m",
        "prompt": "p",
        "resolution": None,
        "ratio": None,
        "quality": None,
        "image": None,
    }
    cfg = ChannelConfig()
    result = build(internal, cfg, "image", model_name="test-model")
    assert "resolution" not in result
    assert "ratio" not in result
    assert "quality" not in result
    assert "image" not in result
    assert result["model"] == "m"
    assert result["prompt"] == "p"


# ── 删 composite 已消费字段 ────────────────────────────────────

def test_autoclean_removes_consumed_fields():
    """auto-clean 删除 composite 已消费的非目标字段。

    使用 gpt-image-2 的 transforms：
    composite: ["ratio", "resolution"] -> ratio 是目标，resolution 被消费
    """
    internal = {
        "model": "gpt-image-2",
        "prompt": "a cat",
        "capability": "image",
        "resolution": "1K",
        "ratio": "9:16",
        "quality": "high",
        "n": 1,
        "image": None,
    }
    cfg = ChannelConfig()
    result = build(internal, cfg, "image", model_name="gpt-image-2")
    # capability 被删（内部字段）
    assert "capability" not in result
    # image 被删（None）
    assert "image" not in result
    # resolution 被删（composite 已消费）
    assert "resolution" not in result
    # ratio 被转换为像素尺寸
    assert result["ratio"] == "864x1536"
    # 其他字段保留
    assert result["model"] == "gpt-image-2"
    assert result["prompt"] == "a cat"
    assert result["quality"] == "high"
    assert result["n"] == 1


# ── nanobanana 无 transforms ──────────────────────────────────

def test_autoclean_nanobanana_no_transforms():
    """nanobanana 无 transforms，ratio 原值保留。"""
    internal = {
        "model": "nanobanana",
        "prompt": "a cat",
        "capability": "image",
        "ratio": "16:9",
        "quality": "auto",
        "n": 1,
        "image": None,
    }
    cfg = ChannelConfig()
    result = build(internal, cfg, "image", model_name="nanobanana")
    assert "capability" not in result
    assert "image" not in result
    # ratio 原值保留（无 transforms）
    assert result["ratio"] == "16:9"
    assert result["quality"] == "auto"
    assert result["n"] == 1


# ── 完整链路：transforms -> auto-clean -> mapping -> patch ────

def test_full_pipeline_gpt_image_2():
    """gpt-image-2 完整链路：transforms 查表 -> auto-clean -> mapping 改名。"""
    internal = {
        "model": "gpt-image-2",
        "prompt": "a cat",
        "capability": "image",
        "resolution": "1K",
        "ratio": "9:16",
        "quality": "high",
        "n": 1,
        "image": None,
    }
    cfg = ChannelConfig(
        request=RequestConfig(
            mapping={"ratio": "size"},
        ),
    )
    result = build(internal, cfg, "image", model_name="gpt-image-2")
    # ratio -> size（mapping 改名）
    assert "ratio" not in result
    assert result["size"] == "864x1536"
    # resolution 被消费删除
    assert "resolution" not in result
    # capability 和 image(None) 被清理
    assert "capability" not in result
    assert "image" not in result
    # 其他字段保留
    assert result["model"] == "gpt-image-2"
    assert result["prompt"] == "a cat"
    assert result["quality"] == "high"
    assert result["n"] == 1


def test_full_pipeline_nanobanana():
    """nanobanana 完整链路：无 transforms -> auto-clean -> mapping 改名。"""
    internal = {
        "model": "nanobanana",
        "prompt": "a cat",
        "capability": "image",
        "ratio": "16:9",
        "quality": "auto",
        "n": 1,
        "image": None,
    }
    cfg = ChannelConfig(
        request=RequestConfig(
            mapping={"ratio": "size"},
        ),
    )
    result = build(internal, cfg, "image", model_name="nanobanana")
    # ratio -> size（mapping 改名），值原样
    assert "ratio" not in result
    assert result["size"] == "16:9"
    # capability 和 image(None) 被清理
    assert "capability" not in result
    assert "image" not in result
    # 其他字段保留
    assert result["model"] == "nanobanana"
    assert result["prompt"] == "a cat"
    assert result["quality"] == "auto"
    assert result["n"] == 1

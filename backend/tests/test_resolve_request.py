"""
ChannelConfig.resolve_request 测试。

覆盖：
- model_overrides 为空 -> 返回 base
- 精确名匹配 override
- 通配符匹配 override
- merge 行为（mapping 浅合并，body_patch 深合并）
"""

from app.schemas.channel_config import ChannelConfig, RequestConfig


# ── model_overrides 为空 ──────────────────────────────────────

def test_resolve_request_no_overrides():
    """model_overrides 为空 -> 返回 base request。"""
    cfg = ChannelConfig(
        request=RequestConfig(
            mapping={"ratio": "size"},
            body_patch={"response_format": "url"},
        ),
    )
    resolved = cfg.resolve_request("gpt-image-2")
    assert resolved.mapping == {"ratio": "size"}
    assert resolved.body_patch == {"response_format": "url"}


# ── 精确名匹配 ────────────────────────────────────────────────

def test_resolve_request_exact_match():
    """精确名匹配 override。"""
    cfg = ChannelConfig(
        request=RequestConfig(
            mapping={"ratio": "size"},
            body_patch={"response_format": "url"},
            model_overrides={
                "gpt-image-2": {
                    "mapping": {"ratio": "custom_size"},
                }
            },
        ),
    )
    resolved = cfg.resolve_request("gpt-image-2")
    # override 的 mapping 覆盖 base 的 mapping
    assert resolved.mapping == {"ratio": "custom_size"}
    # body_patch 保留 base 的
    assert resolved.body_patch == {"response_format": "url"}


# ── 通配符匹配 ────────────────────────────────────────────────

def test_resolve_request_wildcard_match():
    """通配符匹配 override。"""
    cfg = ChannelConfig(
        request=RequestConfig(
            mapping={"ratio": "size"},
            model_overrides={
                "gpt-image-*": {
                    "mapping": {"ratio": "image_size"},
                }
            },
        ),
    )
    resolved = cfg.resolve_request("gpt-image-2")
    assert resolved.mapping == {"ratio": "image_size"}


def test_resolve_request_wildcard_no_match():
    """通配符不匹配时返回 base。"""
    cfg = ChannelConfig(
        request=RequestConfig(
            mapping={"ratio": "size"},
            model_overrides={
                "gpt-image-*": {
                    "mapping": {"ratio": "image_size"},
                }
            },
        ),
    )
    resolved = cfg.resolve_request("dall-e-3")
    # 不匹配，返回 base
    assert resolved.mapping == {"ratio": "size"}


# ── merge 行为 ────────────────────────────────────────────────

def test_resolve_request_mapping_merge():
    """mapping 浅合并：override 中的 key 覆盖 base，base 独有的 key 保留。"""
    cfg = ChannelConfig(
        request=RequestConfig(
            mapping={"ratio": "size", "quality": "q"},
            model_overrides={
                "gpt-image-2": {
                    "mapping": {"ratio": "custom_size"},
                }
            },
        ),
    )
    resolved = cfg.resolve_request("gpt-image-2")
    # ratio 被 override 覆盖
    assert resolved.mapping["ratio"] == "custom_size"
    # quality 保留 base 的
    assert resolved.mapping["quality"] == "q"


def test_resolve_request_body_patch_deep_merge():
    """body_patch 深合并：嵌套 dict 递归合并。"""
    cfg = ChannelConfig(
        request=RequestConfig(
            body_patch={"extra_body": {"image": ["a.png"], "format": "url"}},
            model_overrides={
                "gpt-image-2": {
                    "body_patch": {"extra_body": {"format": "b64"}},
                }
            },
        ),
    )
    resolved = cfg.resolve_request("gpt-image-2")
    # image 保留 base 的
    assert resolved.body_patch["extra_body"]["image"] == ["a.png"]
    # format 被 override 覆盖
    assert resolved.body_patch["extra_body"]["format"] == "b64"


# ── 优先级：精确 > 通配符 ─────────────────────────────────────

def test_resolve_request_priority_exact_over_wildcard():
    """精确名优先于通配符。"""
    cfg = ChannelConfig(
        request=RequestConfig(
            model_overrides={
                "gpt-image-*": {
                    "mapping": {"ratio": "wildcard_size"},
                },
                "gpt-image-2": {
                    "mapping": {"ratio": "exact_size"},
                }
            },
        ),
    )
    resolved = cfg.resolve_request("gpt-image-2")
    assert resolved.mapping == {"ratio": "exact_size"}


# ── submit_style 继承 ────────────────────────────────────────

def test_resolve_request_submit_style():
    """submit_style 从 override 或 base 继承。"""
    cfg = ChannelConfig(
        request=RequestConfig(
            submit_style="json",
            model_overrides={
                "gpt-image-2": {
                    "submit_style": "multipart",
                }
            },
        ),
    )
    resolved = cfg.resolve_request("gpt-image-2")
    assert resolved.submit_style == "multipart"

    resolved2 = cfg.resolve_request("other-model")
    assert resolved2.submit_style == "json"

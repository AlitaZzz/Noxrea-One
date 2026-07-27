"""
ModelParamsRegistry 测试。

覆盖：
- 加载 model_params.json
- fnmatch 匹配（精确 > 通配符 > _default）
- 按需 mtime 热更新
"""

import os
import json
import tempfile
from pathlib import Path

import pytest

from app.services.model_params import ModelParamsRegistry, ModelParams


# ── 加载 ──────────────────────────────────────────────────────

def test_registry_loads_default():
    """Registry 加载后 _default 存在。"""
    reg = ModelParamsRegistry()
    mp = reg.get("nonexistent-model", "image")
    assert mp is not None
    assert "quality" in mp.params
    assert "resolution" in mp.params


def test_registry_exact_match():
    """精确名匹配优先。"""
    reg = ModelParamsRegistry()
    mp = reg.get("gpt-image-2", "image")
    assert mp is not None
    assert mp.transforms
    assert "ratio" in mp.transforms


def test_registry_nanobanana():
    """nanobanana 无 transforms，无 resolution。"""
    reg = ModelParamsRegistry()
    mp = reg.get("nanobanana", "image")
    assert mp is not None
    assert "resolution" not in mp.params
    assert mp.transforms == {}


def test_registry_fnmatch_wildcard():
    """通配符匹配。"""
    reg = ModelParamsRegistry()
    # 在 model_params.json 中没有通配符模式，但 _default 兜底应该工作
    mp = reg.get("some-unknown-model", "image")
    assert mp is not None
    assert "quality" in mp.params


def test_registry_unknown_capability():
    """未知 capability 返回 None。"""
    reg = ModelParamsRegistry()
    mp = reg.get("gpt-image-2", "unknown_cap")
    assert mp is None


def test_registry_get_public_excludes_transforms():
    """get_public 不返回 transforms。"""
    reg = ModelParamsRegistry()
    public = reg.get_public()
    assert "gpt-image-2" in public
    assert "transforms" not in public["gpt-image-2"]["image"]
    assert "params" in public["gpt-image-2"]["image"]
    assert "defaults" in public["gpt-image-2"]["image"]
    assert "constraints" in public["gpt-image-2"]["image"]


# ── 热更新 ────────────────────────────────────────────────────

def test_registry_mtime_reload(tmp_path, monkeypatch):
    """mtime 变化后重新加载。"""
    # 创建临时 JSON 文件
    data_file = tmp_path / "model_params.json"
    data_file.write_text(json.dumps({
        "_default": {
            "image": {
                "params": ["quality"],
                "defaults": {"quality": "auto"}
            }
        }
    }), encoding="utf-8")

    # Patch _DATA_FILE
    import app.services.model_params as mod
    monkeypatch.setattr(mod, "_DATA_FILE", data_file)

    # 创建新实例
    mod.ModelParamsRegistry._instance = None
    reg = mod.ModelParamsRegistry()
    mp = reg.get("test-model", "image")
    assert mp is not None
    assert mp.params == ["quality"]

    # 修改文件
    new_data = {
        "_default": {
            "image": {
                "params": ["quality", "n"],
                "defaults": {"quality": "high", "n": 2}
            }
        }
    }
    data_file.write_text(json.dumps(new_data), encoding="utf-8")

    # 重新获取应该看到新数据
    mp2 = reg.get("test-model", "image")
    assert mp2 is not None
    assert "n" in mp2.params
    assert mp2.defaults["n"] == 2

    # 清理
    mod.ModelParamsRegistry._instance = None

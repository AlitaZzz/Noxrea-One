"""
FieldMapping — 基于 channel 配置的参数字段重映射与 override。

Adapters 生成标准 Provider 格式（OpenAI / Gemini / Ark）后，
FieldMapping 按 channel 的 config JSON 调整字段。

config 格式（三合一）：
    {
        "params": {"source_field": "target.dot.path"},
        "endpoints": {"image.generations": "/custom/path"},
        "body": {"extra_body": {"response_format": "url"}}
    }

parse_channel_config() 将合并后的 config 拆为 (params, endpoints, body) 三元组，
各 capability service 继续使用原有的 apply_* 函数。

调用顺序：
    Adapter → apply_parameter_mapping → apply_override_json → Protocol
"""

from __future__ import annotations

import copy
import json
from typing import Any


def _ensure_dict(v: Any) -> dict:
    """将值安全转为 dict：dict 原样返回，字符串尝试 JSON 解析，其他返回 {}。"""
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
            return parsed if isinstance(parsed, dict) else {}
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def parse_channel_config(raw: dict | None) -> tuple[dict, dict, dict]:
    """将合并后的 config JSON 拆为 (params, endpoints, body) 三元组。

    config 结构：
        {"params": {...}, "endpoints": {...}, "body": {...}}

    Worker 在 executor 边界调用本函数拆包后，
    以独立 dict 形式填入 ExecutionContext 并下传，避免各层感知存储格式。

    容错：如果子字段是 JSON 字符串（旧数据迁移遗留问题），会自动解析为对象。
    """
    if not raw:
        return {}, {}, {}
    return (
        _ensure_dict(raw.get("params", {})),
        _ensure_dict(raw.get("endpoints", {})),
        _ensure_dict(raw.get("body", {})),
    )


def apply_parameter_mapping(body: dict, mapping: dict | None) -> dict:
    """按 parameter_mapping 配置重映射/删除字段。

    mapping 格式：
        {"source_field": "target.dot.path"}  → 移动字段到嵌套路径
        {"field_to_remove": None}            → 删除字段

    返回修改后的 body（原地修改）。
    """
    if not mapping:
        return body
    for src, target in mapping.items():
        if target is None:
            # 删除字段
            body.pop(src, None)
        elif isinstance(target, str) and src in body:
            value = body.pop(src)
            _set_nested(body, target, value)
    return body


def apply_override_json(body: dict, override: dict | None) -> dict:
    """将 override_json deep merge 到请求体。

    override 中的值直接覆盖 body 中同路径的值。
    嵌套 dict 做递归合并，非 dict 值直接替换。
    """
    if not override:
        return body
    deep_merge(body, override)
    return body


def get_endpoint_override(endpoint_mapping: dict | None, operation: str) -> str | None:
    """从 endpoint_mapping 获取自定义端点路径。

    Args:
        endpoint_mapping: channel 配置的端点映射
        operation: "image.generations" / "image.edits" / "video.generate" 等

    Returns:
        自定义路径，或 None（使用 Protocol 默认）
    """
    if not endpoint_mapping:
        return None
    return endpoint_mapping.get(operation)


# ── 内部工具 ──────────────────────────────────────────────────


def _set_nested(d: dict, path: str, value: Any) -> None:
    """将 value 设置到嵌套路径。例如 path='extra_body.image' → d['extra_body']['image']=value"""
    parts = path.split(".")
    for part in parts[:-1]:
        if part not in d or not isinstance(d[part], dict):
            d[part] = {}
        d = d[part]
    d[parts[-1]] = value


def deep_merge(base: dict, override: dict) -> dict:
    """递归 deep merge：override 中的嵌套 dict 与 base 合并，非 dict 直接覆盖。"""
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            deep_merge(base[key], value)
        else:
            base[key] = copy.deepcopy(value)
    return base

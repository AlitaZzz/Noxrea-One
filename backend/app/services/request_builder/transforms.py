"""
值变换（Transforms）—— 对指定字段的值做编码/格式转换。

支持的变换类型：
    - "base64": 将字段值（URL 列表）转为 base64 编码的 data URL

transforms 格式：
    {"字段路径": "base64"}
    
例：{"extra_body.image": "base64"} → 将 body["extra_body"]["image"] 中的 URL 编码为 base64
"""

from __future__ import annotations

import base64
import logging
from typing import Any

logger = logging.getLogger(__name__)

# 支持的变换类型 → 变换函数
_TRANSFORM_REGISTRY: dict[str, callable] = {}


def register_transform(name: str):
    """装饰器：注册一个变换函数。"""
    def decorator(func):
        _TRANSFORM_REGISTRY[name] = func
        return func
    return decorator


@register_transform("base64")
def _transform_base64(value: Any) -> Any:
    """将 URL 列表转为 base64 编码的 data URL。

    如果值已是 base64 格式（以 data: 开头），则跳过编码。
    如果值是列表，则对每个元素单独编码。
    """
    # TODO: 实际 base64 编码需要下载 URL 内容，当前为占位实现
    # 正式实现时应在 executor 层处理下载和编码
    return value


def apply_transforms(body: dict, transforms: dict[str, str]) -> dict:
    """对 body 的指定字段执行值变换（原地修改）。

    Args:
        body: 当前请求体
        transforms: {"字段路径": "变换类型"}，如 {"extra_body.image": "base64"}

    Returns:
        修改后的 body
    """
    if not transforms:
        return body
    for path, transform_type in transforms.items():
        func = _TRANSFORM_REGISTRY.get(transform_type)
        if func is None:
            logger.warning(f"未知的变换类型: {transform_type}，跳过字段 {path}")
            continue
        value = _get_nested(body, path)
        if value is not None:
            _set_nested(body, path, func(value))
    return body


def _get_nested(d: dict, path: str) -> Any:
    """从嵌套路径读取值，路径不存在返回 None。"""
    parts = path.split(".")
    current = d
    for part in parts:
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _set_nested(d: dict, path: str, value: Any) -> None:
    """将 value 设置到嵌套路径。"""
    parts = path.split(".")
    for part in parts[:-1]:
        if part not in d or not isinstance(d[part], dict):
            d[part] = {}
        d = d[part]
    d[parts[-1]] = value

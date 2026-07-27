"""
值变换（Transforms）-- 对指定字段的值做编码/格式转换。

支持的变换类型：
    - "base64": 将字段值（URL 列表）转为 base64 编码的 data URL
    - "lookup": 查表变换，支持 composite 多字段联合查表

transforms 格式（两种值类型）：
    简单变换：{"字段路径": "base64"}
    带参数变换：{"字段路径": {"type": "lookup", "composite": [...], "table": {...}}}

例：
    {"extra_body.image": "base64"}
    {"ratio": {"type": "lookup", "composite": ["ratio", "resolution"], "table": {"1:1|1K": "1024x1024"}}}
"""

from __future__ import annotations

import base64
import logging
from typing import Any

logger = logging.getLogger(__name__)

# 支持的变换类型 -> 变换函数
_TRANSFORM_REGISTRY: dict[str, callable] = {}


def register_transform(name: str):
    """装饰器：注册一个变换函数。"""
    def decorator(func):
        _TRANSFORM_REGISTRY[name] = func
        return func
    return decorator


@register_transform("base64")
def _transform_base64(value: Any, params: dict, body: dict, target_field: str) -> tuple[Any, set]:
    """将 URL 列表转为 base64 编码的 data URL。

    如果值已是 base64 格式（以 data: 开头），则跳过编码。
    如果值是列表，则对每个元素单独编码。

    Returns:
        (转换后的值, consumed_fields) -- base64 不消费其他字段
    """
    # TODO: 实际 base64 编码需要下载 URL 内容，当前为占位实现
    # 正式实现时应在 executor 层处理下载和编码
    return value, set()


@register_transform("lookup")
def _transform_lookup(value: Any, params: dict, body: dict, target_field: str) -> tuple[Any, set]:
    """查表变换，支持单字段和 composite 多字段联合查表。

    params 格式：
        单字段：{"type": "lookup", "table": {"1K": "1024x1024"}}
        composite：{"type": "lookup", "composite": ["ratio", "resolution"], "table": {"9:16|1K": "768x1344"}}

    table 值可以是 str 或 list（取第一个元素）。

    Returns:
        (转换后的值, consumed_fields)
        consumed_fields 包含 composite 中除 target_field 外的字段名
    """
    table = params.get("table", {})
    composite = params.get("composite")

    if composite:
        # composite 多字段联合查表
        key = "|".join(str(body.get(f, "")) for f in composite)
        result = table.get(key, value)
        # 标记 composite 中非目标字段为已消费
        consumed = {f for f in composite if f != target_field}
    else:
        # 单字段查表
        result = table.get(value, value)
        consumed = set()

    # table 值是 list 时取第一个元素
    if isinstance(result, list) and result:
        result = result[0]

    return result, consumed


def apply_transforms(body: dict, transforms: dict[str, Any]) -> tuple[dict, set]:
    """对 body 的指定字段执行值变换（原地修改）。

    Args:
        body: 当前请求体
        transforms: 变换配置，值可以是 str（简单变换）或 dict（带参数变换）

    Returns:
        (body, consumed_fields) -- consumed_fields 记录被 composite 消费的非目标字段
    """
    consumed_total: set = set()
    if not transforms:
        return body, consumed_total

    for field, spec in transforms.items():
        # 解析 spec 为 (transform_name, params)
        if isinstance(spec, str):
            transform_name = spec
            params = {}
        elif isinstance(spec, dict):
            transform_name = spec.get("type")
            params = spec
        else:
            logger.warning(f"变换配置值类型不支持: {type(spec)}，跳过字段 {field}")
            continue

        func = _TRANSFORM_REGISTRY.get(transform_name)
        if func is None:
            logger.warning(f"未知的变换类型: {transform_name}，跳过字段 {field}")
            continue

        value = _get_nested(body, field)
        if value is not None:
            new_value, consumed = func(value, params, body, target_field=field)
            _set_nested(body, field, new_value)
            consumed_total.update(consumed)

    return body, consumed_total


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

"""
字段映射（Mapping）—— 将内部字段改名/移动到嵌套路径。

mapping 格式：
    {"source_field": "target.dot.path"}  → 移动字段到嵌套路径
    {"source_field": "arr[].nested"}     → 数组展开：每个元素包装为 {"nested": element}
    {"source_field": "arr[]"}            → 数组直接赋值（不包装）
    {"field_to_remove": None}            → 删除字段
"""

from __future__ import annotations

from typing import Any


def apply_mapping(body: dict, mapping: dict[str, str | None]) -> dict:
    """按 mapping 配置重映射/删除字段（原地修改）。

    Args:
        body: 当前请求体
        mapping: 字段映射表，值可以是目标路径字符串或 None（删除）

    Returns:
        修改后的 body（同一引用）
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


def _set_nested(d: dict, path: str, value: Any) -> None:
    """将 value 设置到嵌套路径，支持 [] 数组展开语法。

    示例：
        path='extra_body.image'                   → d['extra_body']['image'] = value
        path='images[].image_url', value=['u1','u2'] → d['images'] = [{'image_url':'u1'}, {'image_url':'u2'}]
        path='images[]',           value=['u1','u2'] → d['images'] = ['u1','u2']
    """
    # ---------- 数组展开路径 ----------
    if "[]" in path:
        if not isinstance(value, list):
            # 值不是列表，去掉 [] 按普通路径处理
            path = path.replace("[]", "")
            _set_nested(d, path, value)
            return

        prefix, rest = path.split("[]", 1)
        suffix = rest.lstrip(".")  # 去掉开头的 .

        # 构建前缀路径（不含 [] 和后续部分）
        if prefix.rstrip("."):
            prefix = prefix.rstrip(".")

        if not suffix:
            # "images[]" → 直接赋值列表
            _set_nested_raw(d, prefix, value)
            return

        # "images[].image_url" → 每个元素包装为 {"image_url": item}
        result = []
        for item in value:
            obj = {}
            _set_nested_raw(obj, suffix, item)
            result.append(obj)

        _set_nested_raw(d, prefix, result)
        return

    # ---------- 普通嵌套路径 ----------
    _set_nested_raw(d, path, value)


def _set_nested_raw(d: dict, path: str, value: Any) -> None:
    """不处理 [] 语法的纯嵌套路径写入。"""
    if not path:
        # 空路径（前缀路径为空时可能出现）
        return
    parts = path.split(".")
    for part in parts[:-1]:
        if part not in d or not isinstance(d[part], dict):
            d[part] = {}
        d = d[part]
    d[parts[-1]] = value

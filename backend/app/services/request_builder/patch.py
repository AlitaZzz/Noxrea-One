"""
固定注入（Patch）—— 将 body_patch 配置 deep merge 到请求体。

body_patch 中的值直接覆盖 body 中同路径的值，
嵌套 dict 做递归合并，非 dict 值直接替换。

从旧 adapters/mapping.py 的 apply_override_json 迁移而来。
"""

from __future__ import annotations

import copy
from typing import Any


def apply_patch(body: dict, patch: dict | None) -> dict:
    """将 patch deep merge 到 body（原地修改）。

    Args:
        body: 当前请求体
        patch: 要注入的配置，嵌套 dict 递归合并，非 dict 直接替换

    Returns:
        修改后的 body
    """
    if not patch:
        return body
    deep_merge(body, patch)
    return body


def deep_merge(base: dict, override: dict) -> dict:
    """递归 deep merge：override 中的嵌套 dict 与 base 合并，非 dict 直接覆盖。"""
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            deep_merge(base[key], value)
        else:
            base[key] = copy.deepcopy(value)
    return base

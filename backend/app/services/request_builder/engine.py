"""
Request Builder 引擎 —— 将内部请求体转换为 Provider 请求体。

固定执行顺序（不可变更）：
    1. mapping   —— 字段改名/移动到嵌套路径
    2. transforms —— 值变换（base64 编码等）
    3. patch     —— 固定参数注入（deep merge）

调用方只需传入内部请求 dict 和 ChannelConfig，引擎自动按顺序执行。

每个步骤都输出 info 日志，显示 原始 → 步骤 → 结果 的完整转换管线。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.logging_config import log_event
from app.schemas.channel_config import ChannelConfig
from app.services.request_builder.mapping import apply_mapping
from app.services.request_builder.transforms import apply_transforms
from app.services.request_builder.patch import apply_patch

logger = logging.getLogger(__name__)


def build(internal: dict, channel_config: ChannelConfig, capability: str = "", *, task_id: str | None = None) -> dict:
    """将 Internal Request 转换为 Provider Request 体。

    Args:
        internal: 内部请求 dict（业务参数）
        channel_config: 渠道配置对象
        capability: 能力名称（"image"/"video"/"llm"/"audio"），供特殊逻辑使用
        task_id: 任务 ID，用于日志关联

    Returns:
        Provider 格式的请求体 dict

    执行顺序：mapping → transforms → patch
    """
    # 拷贝避免修改入参
    body = dict(internal)
    cfg = channel_config.request

    # 1. 字段映射：改名/移动到嵌套路径
    if cfg.mapping:
        body = apply_mapping(body, cfg.mapping)

    # 2. 值变换：base64 编码等
    if cfg.transforms:
        body = apply_transforms(body, cfg.transforms)

    # 3. 固定注入：deep merge body_patch
    if cfg.body_patch:
        body = apply_patch(body, cfg.body_patch)

    # 日志：回显前端传入的业务参数（转换前）
    kb = max(1, len(json.dumps(body, ensure_ascii=False)) // 1024)
    fields: dict[str, Any] = {"payload_size": f"{kb}KB"}
    fields.update(_summarize_internal(internal))
    logger.info(log_event("builder", task_id=task_id, stage="request_built", **fields))

    # 日志：回显厂商请求体（转换后）
    provider_fields: dict[str, Any] = {"payload_size": f"{kb}KB"}
    provider_fields.update(_summarize_internal(body))
    logger.info(log_event("builder", task_id=task_id, stage="provider_built", **provider_fields))

    return body


# 参考图/大体积字段：只统计数量，不把 base64/URL 打进日志
_REF_KEYS = {"ref_urls", "image", "image_url", "image_urls", "b64_json", "reference_images"}
# 长文本字段：只记录字符数
_TRUNCATE_KEYS = {"prompt", "input", "content", "text"}


def _summarize_internal(internal: dict) -> dict[str, Any]:
    """把前端传入的参数全部回显到日志，对敏感/大体积字段做脱敏。

    - prompt 等长文本 → prompt_len / input_len …（字符数）
    - image / ref_urls 等 → refs=N（数量）
    - 标量 → 原值；list → (N items)；dict → (N keys)
    - None 值跳过
    """
    fields: dict[str, Any] = {}
    refs = 0
    for key, val in internal.items():
        if val is None:
            continue
        if key == "prompt":
            fields["prompt_len"] = _prompt_chars(val)
            continue
        if key in _TRUNCATE_KEYS:
            fields[f"{key}_len"] = len(val) if isinstance(val, str) else _prompt_chars(val)
            continue
        if key in _REF_KEYS:
            refs += len(val) if isinstance(val, list) else (1 if val else 0)
            continue
        if isinstance(val, (str, int, float, bool)):
            fields[key] = val
        elif isinstance(val, list):
            fields[key] = f"({len(val)} items)"
        elif isinstance(val, dict):
            fields[key] = f"({len(val)} keys)"
        else:
            fields[key] = str(val)
    if refs:
        fields["refs"] = refs
    return fields


def _prompt_chars(prompt: Any) -> int:
    """统计提示词字符数：字符串直接 len；messages 列表递归累加 text 内容。"""
    if isinstance(prompt, str):
        return len(prompt)
    if isinstance(prompt, list):
        total = 0
        for item in prompt:
            if isinstance(item, str):
                total += len(item)
            elif isinstance(item, dict):
                for v in item.values():
                    if isinstance(v, str):
                        total += len(v)
                    elif isinstance(v, list):
                        for sub in v:
                            if isinstance(sub, str):
                                total += len(sub)
        return total
    return len(str(prompt))


def _describe_mapping(body: dict, mapping: dict[str, str | None]) -> list[str]:
    """生成映射变更描述，如 ["size → extra_body.size", "n → 删除"]"""
    changes = []
    for src, target in mapping.items():
        if target is None:
            changes.append(f"{src} → 删除")
        elif src in body:
            changes.append(f"{src} → {target}")
        else:
            changes.append(f"{src} (不存在) → {target}")
    return changes


def _describe_transforms(body: dict, transforms: dict[str, str]) -> list[str]:
    """生成变换变更描述，如 ["image → base64"]"""
    changes = []
    for path, ttype in transforms.items():
        exists = "✓" if _path_exists(body, path) else "✗"
        changes.append(f"{path}[{exists}] → {ttype}")
    return changes


def _path_exists(d: dict, path: str) -> bool:
    """检查嵌套路径是否存在。"""
    parts = path.split(".")
    current = d
    for part in parts:
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    return True

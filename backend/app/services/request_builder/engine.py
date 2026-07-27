"""
Request Builder 引擎 -- 将内部请求体转换为 Provider 请求体。

固定执行顺序（不可变更）：
    1. transforms -- 值变换（从 model_params.json 按模型加载，如 ratio->像素尺寸查表）
    2. auto-clean -- 引擎内置清理：删内部字段、删 None 值、删 composite 已消费字段
    3. mapping   -- 字段改名/移动到嵌套路径（渠道级，含 model_overrides）
    4. patch     -- 固定参数注入（deep merge）

调用方只需传入内部请求 dict、ChannelConfig、model_name 和 capability，
引擎自动按顺序执行。

每个步骤都输出 info 日志，显示 原始 -> 步骤 -> 结果 的完整转换管线。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.logging_config import log_event
from app.schemas.channel_config import ChannelConfig
from app.services.model_params import ModelParamsRegistry
from app.services.request_builder.mapping import apply_mapping
from app.services.request_builder.transforms import apply_transforms
from app.services.request_builder.patch import apply_patch

logger = logging.getLogger(__name__)

# 引擎内置清理：这些内部字段不传给 Provider
_INTERNAL_FIELDS = {"capability"}


def build(
    internal: dict,
    channel_config: ChannelConfig,
    capability: str = "",
    model_name: str = "",
    *,
    task_id: str | None = None,
) -> dict:
    """将 Internal Request 转换为 Provider Request 体。

    Args:
        internal: 内部请求 dict（业务参数）
        channel_config: 渠道配置对象
        capability: 能力名称（"image"/"video"/"llm"/"audio"）
        model_name: 模型名称，用于加载模型级 transforms
        task_id: 任务 ID，用于日志关联

    Returns:
        Provider 格式的请求体 dict

    执行顺序：transforms -> auto-clean -> mapping -> patch
    """
    # 拷贝避免修改入参
    body = dict(internal)

    # 0. 提前 resolve，拿到 param_ref（用于 transforms 查表）
    cfg = channel_config.resolve_request(model_name)

    # 1. transforms（模型级，从 model_params.json 加载）
    # param_ref 不为空时，用它代替 model_name 查 transforms/params/defaults/constraints
    transforms_name = cfg.param_ref or model_name
    consumed: set = set()
    model_params = ModelParamsRegistry().get(transforms_name, capability)
    if model_params and model_params.transforms:
        body, consumed = apply_transforms(body, model_params.transforms)

    # 2. auto-clean（引擎内置，无需配置）
    for key in list(body.keys()):
        if key in _INTERNAL_FIELDS:
            del body[key]
        elif body[key] is None:
            del body[key]
        elif key in consumed:
            del body[key]

    # 3. mapping（渠道级，含 model_overrides，复用已 resolve 的 cfg）
    if cfg.mapping:
        body = apply_mapping(body, cfg.mapping)

    # 4. patch（渠道级）
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
_REF_KEYS = {"ref_images", "image", "image_url", "image_urls", "b64_json", "reference_images"}
# 长文本字段：只记录字符数
_TRUNCATE_KEYS = {"prompt", "input", "content", "text"}


def _summarize_internal(internal: dict) -> dict[str, Any]:
    """把前端传入的参数全部回显到日志，对敏感/大体积字段做脱敏。

    - prompt 等长文本 -> prompt_len / input_len …（字符数）
    - image / ref_images 等 -> refs=N（数量）
    - 标量 -> 原值；list -> (N items)；dict -> (N keys)
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

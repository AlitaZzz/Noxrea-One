"""TaskExecutionParams — 从 task.config 提取 Capability 执行所需的业务参数。

Worker 不应理解业务字段，也不应把数据库/基础设施字段
（channel_id / protocol / capability / model）泄露给 Capability Request。
本模块是唯一的字段契约（白名单）。

重构后使用 OpenAI 官方参数名，兼容旧前端字段名（如 duration → seconds）。
"""

from __future__ import annotations

from typing import Any

# Capability 层实际消费的业务参数字段（白名单）—— 使用 OpenAI 官方名。
_BUSINESS_PARAM_KEYS: set[str] = {
    # image（OpenAI 官方参数名）
    "size", "ratio", "quality", "n", "strength", "seed",
    # video（OpenAI 官方参数名：seconds 替代旧 duration）
    "seconds", "width", "height", "frame_rate",
    # video 兼容旧字段名（前端未更新时可用）
    "duration", "num_frames", "fps",
    # llm（OpenAI 官方参数名）
    "messages", "temperature", "max_tokens", "top_p", "stream", "stop",
    "frequency_penalty", "presence_penalty",
    # audio（OpenAI 官方参数名）
    "mode", "input", "voice", "audio_file",
    # references
    "references",
}

# 必须从 config 中剔除的数据库/基础设施字段（不进入 Capability Request）。
_EXCLUDED_KEYS: set[str] = {"channel_id", "protocol", "capability", "model", "type"}

# 旧字段名 → OpenAI 官方字段名 的兼容映射
_FIELD_ALIASES: dict[str, str] = {
    "duration": "seconds",          # video: duration → seconds
    "fps": "frame_rate",            # video: fps → frame_rate
    "num_frames": "num_frames",     # video: 保留（无直接 OpenAI 对应）
}


def extract_execution_params(config: dict | None) -> dict[str, Any]:
    """从 task.config 提取业务参数，剔除 DB/基础设施字段。

    同时将旧字段名（如 duration）归一化为 OpenAI 官方名（seconds）。
    Worker 调用本函数时无需理解任何业务字段名。
    """
    if not config:
        return {}
    result: dict[str, Any] = {}
    for k, v in config.items():
        if k in _EXCLUDED_KEYS:
            continue
        if k in _BUSINESS_PARAM_KEYS:
            # 归一化：旧名 → 官方名
            key = _FIELD_ALIASES.get(k, k)
            result[key] = v
    return result

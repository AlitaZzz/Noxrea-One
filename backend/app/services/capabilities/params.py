"""TaskExecutionParams — 从 task.config 提取 Capability 执行所需的业务参数。

Worker 不应理解业务字段，也不应把数据库/基础设施字段
（channel_id / protocol / capability / model）泄露给 Capability Request。
本模块是唯一的字段契约（白名单）。
"""
from __future__ import annotations

from typing import Any

# Capability 层实际消费的业务参数字段（白名单）。
_BUSINESS_PARAM_KEYS: set[str] = {
    # image
    "size", "ratio", "quality", "n", "strength", "seed",
    # video
    "duration", "width", "height", "num_frames", "frame_rate", "fps",
    # llm
    "messages", "temperature", "max_tokens", "top_p", "stream", "stop",
    "frequency_penalty", "presence_penalty",
    # audio
    "mode", "input", "voice", "audio_file",
    # references
    "references",
}

# 必须从 config 中剔除的数据库/基础设施字段（不进入 Capability Request）。
_EXCLUDED_KEYS: set[str] = {"channel_id", "protocol", "capability", "model", "type"}


def extract_execution_params(config: dict | None) -> dict[str, Any]:
    """从 task.config 提取业务参数，剔除 DB/基础设施字段。

    Worker 调用本函数时无需理解任何业务字段名。
    """
    if not config:
        return {}
    return {
        k: v
        for k, v in config.items()
        if k in _BUSINESS_PARAM_KEYS and k not in _EXCLUDED_KEYS
    }

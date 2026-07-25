"""
ArkBaseProtocol — 火山方舟协议族基类（暂未实现）。

TODO: 响应包裹在 {"code", "data"} 中；异步图片/视频：先提交获取 task_id，再轮询。
"""

from __future__ import annotations

from app.services.protocols.base import BaseProtocol


class ArkBaseProtocol(BaseProtocol):
    """Ark 协议族基类（占位）。"""

    protocol_name: str = "ark"

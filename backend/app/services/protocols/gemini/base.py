"""
GeminiBaseProtocol — Gemini 协议族基类（暂未实现）。

TODO: 保持 Gemini 原生格式，不强行转 OpenAI。
"""

from __future__ import annotations

from app.services.protocols.base import BaseProtocol


class GeminiBaseProtocol(BaseProtocol):
    """Gemini 协议族基类（占位）。"""

    protocol_name: str = "gemini"

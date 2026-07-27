"""
Capability 基础层 — BaseCapabilityService + CapabilityRegistry。

Capability 表示"用户想做什么"（image / video / llm / audio / bg_removal），
不感知厂商、不感知具体协议，只负责协调 request_builder → Protocol → TaskManager 流程。

强制隔离：
- ✗ Capability 不知道 OpenAI / Gemini / Ark
- ✗ Capability 不直接构造 HTTP 请求
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from app.schemas.channel_config import ChannelConfig


class BaseCapabilityService(ABC):
    """能力服务基类。

    每个能力（Image / Video / LLM / Audio / BgRemoval）实现 execute() 方法，
    调用链：request_builder.build() → Protocol → TaskManager。
    """

    capability: str = ""  # "image" / "video" / "llm" / "audio" / "bg_removal"

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if not cls.capability:
            raise TypeError(f"{cls.__name__} 必须声明 capability")

    @abstractmethod
    async def execute(
        self,
        *,
        task_id: str,
        user_id: int,
        prompt: str,
        params: dict,
        base_url: str,
        api_key: str,
        protocol_name: str,
        channel_config: ChannelConfig = ChannelConfig(),
        model: str = "",
        ref_images: list[str] | None = None,
    ) -> dict[str, Any]:
        """执行一次能力调用。

        Args:
            task_id: 任务 ID
            user_id: 用户 ID
            prompt: 用户提示词
            params: 业务参数（从 task.config 提取）
            base_url: 渠道基础 URL
            api_key: 渠道 API 密钥
            protocol_name: 协议名称（"openai" / "gemini" / "ark"）
            channel_config: 渠道高级配置（request + protocol 两块）
            model: 模型名称
            ref_images: 参考图 URL 列表

        Returns:
            {
                "status": "completed" | "failed" | "processing",
                "urls": [...],
                "files": [...],      # raw bytes（如 TTS），由 executor 落本地
                "error": "...",      # 仅 failed
                "upstream_task_id": "...",  # 仅 processing（异步等待）
                "metadata": {...},
            }
        """
        ...


class CapabilityRegistry:
    """能力注册表：按 capability 名称注册服务。"""

    _services: dict[str, BaseCapabilityService] = {}

    @classmethod
    def register(cls, capability: str, service: BaseCapabilityService) -> None:
        if service.capability != capability:
            raise ValueError(
                f"Service capability '{service.capability}' != registry key '{capability}'"
            )
        cls._services[capability] = service

    @classmethod
    def get(cls, capability: str) -> BaseCapabilityService | None:
        return cls._services.get(capability)

    @classmethod
    def list_capabilities(cls) -> list[str]:
        return list(cls._services.keys())

    @classmethod
    def has(cls, capability: str) -> bool:
        return capability in cls._services

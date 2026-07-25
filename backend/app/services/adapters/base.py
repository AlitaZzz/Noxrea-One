"""
BaseAdapter — Provider 级参数适配基类。

Adapter 按 Provider 维度划分（openai / gemini / ark），不按 capability 划分。
兼容接口差异通过 channel 配置的 parameter_mapping + override_json 解决，
不为此创建新 Adapter。

Adapter 职责：
- ✓ 厂商参数转换（size_level→像素 size、ref_urls→厂商字段）
- ✓ 厂商特定默认值注入

Adapter 禁止：
- ✗ HTTP 协议细节（endpoint / headers / auth）
- ✗ 响应解析
- ✗ capability 判断（image/video/audio，由调用方传入）
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseAdapter(ABC):
    """Provider 级适配器基类。

    每个 Adapter 对应一种 Provider API 风格（OpenAI / Gemini / Ark），
    不绑定到具体模型名或 capability。
    """

    name: str = ""  # "openai" / "gemini" / "ark"

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if not cls.name:
            raise TypeError(f"{cls.__name__} 必须声明 name")

    @abstractmethod
    def adapt_params(self, params: dict, capability: str) -> dict:
        """将内部统一请求转换为 Provider 格式。

        Args:
            params: 内部请求参数（size_level / ratio / quality / n / ref_urls 等）
            capability: "image" / "video" / "llm" / "audio"

        Returns:
            Provider 格式的参数 dict
        """
        ...


class AdapterRegistry:
    """适配器注册表：按 Provider 名称查找。

    选择由数据库配置的 channel.adapter（或 channel.protocol）决定，
    不再通过 model 名字串匹配。
    """

    _adapters: dict[str, BaseAdapter] = {}

    @classmethod
    def register(cls, adapter: BaseAdapter) -> None:
        cls._adapters[adapter.name] = adapter

    @classmethod
    def get(cls, name: str) -> BaseAdapter | None:
        """按 Provider 名称查找 Adapter。"""
        return cls._adapters.get(name)

    @classmethod
    def apply(cls, adapter_name: str, params: dict, capability: str) -> dict:
        """应用适配器转换（若找到），否则返回原参数。"""
        adapter = cls.get(adapter_name)
        if adapter:
            return adapter.adapt_params(params, capability)
        return params

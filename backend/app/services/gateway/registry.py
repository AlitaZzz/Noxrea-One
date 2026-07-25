"""
Gateway Registry — 能力注册表 + 协议注册表 + 适配器注册表的管理中心。

网关启动时在此完成所有注册，Router 通过注册表动态分发。
"""

from app.services.capabilities.base import CapabilityRegistry
from app.services.protocols.base import ProtocolRegistry
from app.services.adapters.base import AdapterRegistry


def init_gateway() -> None:
    """初始化网关：注册所有能力、协议和适配器。在应用启动时调用一次。"""
    # ── 注册 Adapter（按 Provider 维度） ──
    from app.services.adapters.openai import OpenAIAdapter
    # TODO: Ark/Gemini 暂未实现
    # from app.services.adapters.gemini import GeminiAdapter
    # from app.services.adapters.ark import ArkAdapter
    AdapterRegistry.register(OpenAIAdapter())
    # AdapterRegistry.register(GeminiAdapter())
    # AdapterRegistry.register(ArkAdapter())

    # ── 注册图片协议 ──
    from app.services.protocols.openai.image import OpenAIImageProtocol
    # TODO: Ark/Gemini 图片协议暂未实现
    # from app.services.protocols.gemini.image import GeminiImageProtocol
    # from app.services.protocols.ark.image import ArkImageProtocol
    ProtocolRegistry.register(OpenAIImageProtocol(), "image")
    # ProtocolRegistry.register(GeminiImageProtocol(), "image")
    # ProtocolRegistry.register(ArkImageProtocol(), "image")

    # ── 注册视频协议 ──
    # TODO: Ark 视频协议暂未实现
    # from app.services.protocols.ark.video import ArkVideoProtocol
    from app.services.protocols.openai.video import OpenAIVideoProtocol
    # ProtocolRegistry.register(ArkVideoProtocol(), "video")
    ProtocolRegistry.register(OpenAIVideoProtocol(), "video")

    # ── 注册 LLM 协议 ──
    from app.services.protocols.openai.llm import OpenAILLMProtocol
    # TODO: Gemini LLM 协议暂未实现
    # from app.services.protocols.gemini.llm import GeminiLLMProtocol
    ProtocolRegistry.register(OpenAILLMProtocol(), "llm")
    # ProtocolRegistry.register(GeminiLLMProtocol(), "llm")

    # ── 注册音频协议 ──
    from app.services.protocols.openai.audio import OpenAIAudioProtocol
    ProtocolRegistry.register(OpenAIAudioProtocol(), "audio")

    # ── 注册能力服务 ──
    from app.services.capabilities.image.service import register as _reg_image
    from app.services.capabilities.video.service import register as _reg_video
    from app.services.capabilities.llm.service import register as _reg_llm
    from app.services.capabilities.audio.service import register as _reg_audio
    from app.services.capabilities.bg_removal.service import register as _reg_bg
    _reg_image()
    _reg_video()
    _reg_llm()
    _reg_audio()
    _reg_bg()


__all__ = [
    "CapabilityRegistry",
    "ProtocolRegistry",
    "AdapterRegistry",
    "init_gateway",
]

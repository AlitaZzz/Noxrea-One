"""
Capability 内部请求（Capability Internal Request）—— 三层参数模型的中间层。

参数流（重构后——OpenAI-native 架构）：

  User Request              前端/API → task.config              业务语义，无厂商字段
        │  CapabilityService：校验 + 默认值 + 规范化
        ▼
  Capability Internal Request   ← 本模块定义                    使用 OpenAI 官方参数名
        │  request_builder.engine.build()：mapping → transforms → patch
        ▼
  Provider Request           引擎输出的 dict                    厂商 API 格式（由 ChannelConfig 决定）

设计约束：
- 本层使用 OpenAI 官方参数名（size / ratio / quality / n / messages 等）。
- 禁止自创字段名（旧 size_level 等已废弃）。
- image 是唯一保留的非官方扩展字段（参考图列表）。
- 每个 capability 定义自己的 Request（ImageRequest / VideoRequest / AudioRequest / LlmRequest），
  由对应 CapabilityService 在其 execute() 中构建。
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class BaseInternalRequest(BaseModel):
    """内部请求基类。所有能力 Request 继承它，统一携带 model / prompt / capability。"""

    model: str
    prompt: str = ""
    capability: str = ""


class ImageRequest(BaseInternalRequest):
    """图片生成内部请求 —— 使用 OpenAI 官方参数名。

    size 表示像素尺寸（如 "1024x1024" / "1536x864"），直接使用 OpenAI 格式。
    ratio 保留作为业务辅助字段，由前端传入并在 service 层转换为 size。
    """

    capability: str = "image"
    size: str = Field(default="1024x1024")      # OpenAI 官方像素尺寸
    ratio: str = Field(default="1:1")            # 业务辅助："1:1" / "16:9" 等
    quality: str = Field(default="standard")     # "standard" | "hd"（对齐 OpenAI）
    n: int = Field(default=1, ge=1, le=4)
    image: Optional[list[str]] = None            # 参考图列表（非官方扩展字段）


class VideoRequest(BaseInternalRequest):
    """视频生成内部请求 —— 使用 OpenAI 官方参数名。

    对应 OpenAI video API 参数：
    - size: 分辨率（如 "1920x1080"）
    - seconds: 视频时长（秒）
    - fps: 帧率
    """

    capability: str = "video"
    size: str = Field(default="1920x1080")       # 分辨率
    seconds: int = Field(default=5)               # 时长（秒）
    width: int = Field(default=1920)              # 宽
    height: int = Field(default=1080)             # 高
    frame_rate: int = Field(default=24)           # 帧率
    ref_urls: Optional[list[str]] = None          # 参考图


class AudioRequest(BaseInternalRequest):
    """音频生成内部请求 —— 使用 OpenAI 官方参数名。

    mode: "tts"（文字转语音）| "stt"（语音转文字）
    """

    capability: str = "audio"
    mode: str = "tts"                             # "tts" | "stt"
    input: str = ""                               # TTS 输入文本
    voice: str = "alloy"                          # 音色（OpenAI: alloy/echo/fable/onyx/nova/shimmer）
    audio_file: str = ""                          # STT 输入音频文件（base64 或 URL）


class LlmRequest(BaseInternalRequest):
    """LLM 调用内部请求 —— 使用 OpenAI 官方参数名。"""

    capability: str = "llm"
    messages: list[dict] = Field(default_factory=list)  # OpenAI 标准 messages
    temperature: float = Field(default=1.0)
    max_tokens: int = Field(default=4096)
    top_p: float = Field(default=1.0)
    stream: bool = Field(default=False)
    stop: Optional[list[str]] = None
    frequency_penalty: float = Field(default=0.0)
    presence_penalty: float = Field(default=0.0)

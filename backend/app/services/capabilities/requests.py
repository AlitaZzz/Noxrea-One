"""
Capability 内部请求（Capability Internal Request）-- 三层参数模型的中间层。

参数流：

  User Request              前端/API -> task.config              业务语义，无厂商字段
        │  CapabilityService：校验 + 默认值 + 规范化
        ▼
  Capability Internal Request   ← 本模块定义                    纯业务语义参数
        │  request_builder.engine.build()：mapping -> transforms -> patch
        ▼
  Provider Request           引擎输出的 dict                    厂商 API 格式（由 ChannelConfig 决定）

设计约束：
- 每个 capability 定义自己的 Request（ImageRequest / VideoRequest / AudioRequest / LlmRequest），
  由对应 CapabilityService 在其 execute() 中构建。
- Internal Request 使用纯业务语义（resolution / ratio / seconds …），
  不包含任何厂商专属参数名。厂商格式转换由 request_builder + ChannelConfig 负责。
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
    """图片生成内部请求。

    resolution 表示清晰度档位（如 "1K" / "2K" / "4K"），由前端传入。
    ratio 表示宽高比（如 "1:1" / "9:16"），由前端传入。
    """

    capability: str = "image"
    resolution: str = Field(default="1K")        # 清晰度档位："1K" / "2K" / "4K"
    ratio: str = Field(default="1:1")            # 宽高比："1:1" / "9:16" 等
    quality: str = Field(default="standard")     # "standard" | "hd" | "low"
    n: int = Field(default=1, ge=1, le=4)
    image: Optional[list[str]] = None            # 参考图列表


class VideoRequest(BaseInternalRequest):
    """视频生成内部请求。

    resolution 表示清晰度档位（如 "1K" / "2K" / "4K"），由前端传入。
    ratio 表示宽高比（如 "16:9" / "9:16"），由前端传入。
    """

    capability: str = "video"
    resolution: str = Field(default="1K")        # 清晰度档位："1K" / "2K" / "4K"
    ratio: str = Field(default="16:9")           # 宽高比："16:9" / "9:16" 等
    seconds: int = Field(default=5)               # 时长（秒）
    frame_rate: int = Field(default=24)           # 帧率
    ref_urls: Optional[list[str]] = None          # 参考图


class AudioRequest(BaseInternalRequest):
    """音频生成内部请求。

    mode: "tts"（文字转语音）| "stt"（语音转文字）
    """

    capability: str = "audio"
    mode: str = "tts"                             # "tts" | "stt"
    input: str = ""                               # TTS 输入文本
    voice: str = "alloy"                          # 音色
    audio_file: str = ""                          # STT 输入音频文件（base64 或 URL）


class LlmRequest(BaseInternalRequest):
    """LLM 调用内部请求。"""

    capability: str = "llm"
    messages: list[dict] = Field(default_factory=list)  # 对话消息列表
    temperature: float = Field(default=1.0)
    max_tokens: int = Field(default=4096)
    top_p: float = Field(default=1.0)
    stream: bool = Field(default=False)
    stop: Optional[list[str]] = None
    frequency_penalty: float = Field(default=0.0)
    presence_penalty: float = Field(default=0.0)

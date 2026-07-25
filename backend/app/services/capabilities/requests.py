"""
Capability 内部请求（Capability Internal Request）—— 三层参数模型的中间层。

参数流（详见设计文档）：

  User Request              前端/API → task.config              业务语义，无厂商字段
        │  CapabilityService：校验 + 默认值 + 规范化
        ▼
  Capability Internal Request   ← 本模块定义                    系统内部统一模型，仍无厂商字段
        │  Adapter：按 model 转换为目标 Provider 格式
        ▼
  Provider Request           Adapter 输出的 dict                厂商 API 格式（resolution / 像素 size 等）

设计约束：
- 本层只表达"用户想生成什么"，例如 size_level="1K" / ratio="1:1" / quality="high"。
- 禁止出现厂商字段：resolution / image_size / 像素 size(1024x1024) 等都属于 Provider 层。
- 每个 capability 定义自己的 Request（ImageRequest / VideoRequest / TextRequest / AudioRequest），
  由对应 CapabilityService 在其 execute() 中构建。

图片能力作为第一个迁移案例，已实现 ImageRequest。其余能力后续按相同模式补齐
（各自 Request 继承 BaseInternalRequest，execute() 内完成业务校验/规范化）。
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
    """图片生成内部请求——仅业务语义。

    size_level 表示尺寸档位（业务概念："1K"/"2K"/"4K"），
    不是像素。像素或厂商特定的 resolution 由 Adapter 在第三层负责生成。
    """

    capability: str = "image"
    size_level: str = Field(default="1K")  # 业务档位，非像素
    ratio: str = Field(default="1:1")       # "1:1" / "16:9" ...
    quality: str = Field(default="auto")    # "auto" / "high" / ...
    n: int = Field(default=1, ge=1, le=4)
    ref_urls: Optional[list[str]] = None    # 参考图（业务语义命名）

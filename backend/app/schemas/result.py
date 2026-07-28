"""
统一生成结果对象 GenerationResult。

替代旧的 tuple[list[str], list[bytes]]，统一 Image/Video/LLM/Audio 四种能力的返回。

- Image:  { urls: ["a.png"], mime_type: "image/png" }
- Video:  { urls: ["video.mp4"], metadata: { duration: 5 }, mime_type: "video/mp4" }
- Audio:  { urls: ["audio.mp3"], metadata: { text: "xxx" }, mime_type: "audio/mpeg" }
- LLM:    { urls: [], metadata: { text: "...", model: "gpt-4" }, mime_type: "text/plain" }
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class GenerationResult:
    """能力服务与协议层之间的统一结果结构。"""

    # 资源 URL 列表（本地或远程：本地直接返回，远程由 TaskManager 下载后替换）
    urls: list[str] = field(default_factory=list)

    # 原始文件 bytes 列表（b64 解码后、本地生成等场景）
    files: list[bytes] = field(default_factory=list)

    # 能力/协议可附带的元数据（如 video 的 duration、audio 的转录文本、LLM 的 usage 等）
    metadata: dict[str, Any] = field(default_factory=dict)

    # MIME 类型提示（image/png, video/mp4, audio/mpeg, text/plain 等）
    mime_type: str = ""

    @property
    def is_empty(self) -> bool:
        """无 url、file 或文本内容视为空结果。"""
        return not self.urls and not self.files and not (self.metadata.get("text"))

    @classmethod
    def from_url(cls, url: str, **meta) -> "GenerationResult":
        """便捷构造：单 URL。"""
        return cls(urls=[url], metadata=meta)

    @classmethod
    def from_urls(cls, urls: list[str], **meta) -> "GenerationResult":
        """便捷构造：多 URL。"""
        return cls(urls=urls, metadata=meta)

    @classmethod
    def from_bytes(cls, data: bytes, mime: str = "", **meta) -> "GenerationResult":
        """便捷构造：单 bytes。"""
        return cls(files=[data], mime_type=mime, metadata=meta)

    @classmethod
    def from_metadata(cls, **meta) -> "GenerationResult":
        """便捷构造：仅元数据（如 LLM 返回文本）。"""
        return cls(metadata=meta, mime_type="text/plain")


@dataclass
class PollResult:
    """轮询结果——协议层 parse_poll_response 的返回值。

    由 TaskManager 消费：
    - status="pending"  → 继续轮询
    - status="completed" → 取 urls/files 完成
    - status="failed" → 标失败
    """
    status: str  # "pending" | "completed" | "failed"
    urls: list[str] = field(default_factory=list)
    files: list[bytes] = field(default_factory=list)
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class AsyncSubmission:
    """异步提交结果——携 upstream_task_id 进入 TaskManager 轮询。"""
    upstream_task_id: str
    poll_url: str | None = None  # 若由 TaskManager 自动拼接则留空

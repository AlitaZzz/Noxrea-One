import datetime
from typing import Optional

from sqlalchemy import String, Integer, DateTime, Text, func
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class GenerationTask(Base):
    __tablename__ = "generation_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    # 旧字段：向后兼容，"image" / "video" / "bg_removal"
    type: Mapped[str] = mapped_column(String(30), nullable=False)

    # 新架构字段：capability 为规范化能力名（image/video/llm/audio/bg_removal）
    capability: Mapped[Optional[str]] = mapped_column(String(30), nullable=True, default=None)
    protocol: Mapped[Optional[str]] = mapped_column(String(30), nullable=True, default=None)
    model: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, default=None)
    upstream_task_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, default=None)

    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", index=True
    )  # pending → processing → completed / failed
    prompt: Mapped[str] = mapped_column(Text, nullable=False, default="")
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    ref_urls: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=None)
    # 多图结果：URL 列表（一次生成可返回多张）。result_url 仅作兼容镜像（= 列表首张）。
    result_urls: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=None)
    result_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True, default=None)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True, default=None)
    node_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    @property
    def effective_capability(self) -> str:
        """返回有效的 capability（优先新字段，回退到 type）。"""
        return self.capability or self.type

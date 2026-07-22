import datetime
from typing import Optional

from sqlalchemy import String, Integer, DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AssetFolder(Base):
    __tablename__ = "asset_folders"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    space_key: Mapped[str] = mapped_column(String(20), nullable=False, default="personal")
    parent_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("asset_folders.id", ondelete="CASCADE"), nullable=True, index=True
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AssetItem(Base):
    __tablename__ = "asset_items"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    folder_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("asset_folders.id", ondelete="SET NULL"), nullable=True, index=True
    )
    space_key: Mapped[str] = mapped_column(String(20), nullable=False, default="personal")
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="Untitled")
    type: Mapped[str] = mapped_column(String(20), nullable=False, default="other")
    width: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    height: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    tags: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    extra_data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

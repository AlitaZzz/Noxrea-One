import datetime
from sqlalchemy import String, Integer, BigInteger, DateTime, func, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class FileObject(Base):
    """文件去重记录 — 同一用户同一内容只存一份物理副本"""
    __tablename__ = "file_objects"

    user_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hash: Mapped[str] = mapped_column(String(64), primary_key=True)  # SHA256 hex
    size: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    ext: Mapped[str] = mapped_column(String(10), nullable=False, default="")
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class FileReference(Base):
    """文件引用记录 — 追踪文件被哪些业务实体引用"""
    __tablename__ = "file_references"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    file_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    ref_type: Mapped[str] = mapped_column(String(20), nullable=False)  # asset / canvas_project
    ref_id: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("file_hash", "user_id", "ref_type", "ref_id", name="uq_file_ref"),
        Index("idx_fr_hash_user", "file_hash", "user_id"),
        Index("idx_fr_type_id", "ref_type", "ref_id"),
    )

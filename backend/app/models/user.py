from datetime import datetime
from typing import Optional

from sqlalchemy import String, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(
        String(50), unique=True, index=True, nullable=False
    )
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    avatar: Mapped[Optional[str]] = mapped_column(String(500), nullable=True, default=None)
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="user")
    theme: Mapped[str] = mapped_column(String(10), nullable=False, server_default="dark")
    lang: Mapped[str] = mapped_column(String(10), nullable=False, server_default="zh")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<User(id={self.id}, username={self.username!r}, role={self.role!r})>"

import os

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


def _ensure_db_dir() -> None:
    """Ensure the parent directory of the SQLite database file exists.

    SQLite auto-creates the .db file on first connect, but NOT its parent
    directory. Without this, a fresh checkout fails at startup with
    "unable to open database file" before create_all can run.
    """
    url = settings.DATABASE_URL
    if not url.startswith("sqlite"):
        return
    db_path = url.split("///", 1)[-1]
    db_dir = os.path.dirname(db_path)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)


_ensure_db_dir()

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    connect_args={"timeout": settings.DB_TIMEOUT} if "sqlite" in settings.DATABASE_URL else {},
)

async_session = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass

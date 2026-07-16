from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class UserOut(BaseModel):
    id: int
    username: str
    avatar: Optional[str] = None
    role: str
    theme: str = "dark"
    lang: str = "zh"
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class UserCreate(BaseModel):
    username: str
    password: str  # plaintext — hashed before storage
    avatar: Optional[str] = None
    role: str = "admin"


class UserUpdate(BaseModel):
    username: Optional[str] = None
    avatar: Optional[str] = None
    password: Optional[str] = None
    old_password: Optional[str] = None
    theme: Optional[str] = None
    lang: Optional[str] = None

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


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


class UserUpdate(BaseModel):
    username: Optional[str] = Field(default=None, max_length=50)
    avatar: Optional[str] = None
    password: Optional[str] = None
    old_password: Optional[str] = None
    theme: Optional[str] = None
    lang: Optional[str] = None

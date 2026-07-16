import datetime
from typing import Optional

from pydantic import BaseModel


class TaskCreate(BaseModel):
    type: str  # "image" / "video"
    prompt: str
    config: dict
    ref_urls: Optional[list[str]] = None
    node_id: str


class TaskOut(BaseModel):
    id: str
    user_id: int
    type: str
    status: str
    prompt: str
    config: dict
    ref_urls: Optional[list[str]] = None
    result_url: Optional[str] = None
    error: Optional[str] = None
    node_id: str
    created_at: datetime.datetime
    updated_at: datetime.datetime

    model_config = {"from_attributes": True}

import datetime
from typing import Literal, Optional

from pydantic import BaseModel


TaskTypeValue = Literal["image", "video", "bg_removal"]


class TaskCreate(BaseModel):
    type: TaskTypeValue = "image"
    prompt: str = ""
    config: dict = {}
    ref_urls: Optional[list[str]] = None
    node_id: str = ""


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

import datetime
from typing import Literal, Optional

from pydantic import BaseModel


TaskTypeValue = Literal["image", "video", "llm", "bg_removal"]


class TaskCreate(BaseModel):
    type: TaskTypeValue = "image"
    prompt: str = ""
    config: dict = {}
    ref_images: Optional[list[str]] = None
    node_id: str = ""


class TaskOut(BaseModel):
    id: str
    user_id: int
    type: str
    capability: Optional[str] = None
    protocol: Optional[str] = None
    model: Optional[str] = None
    upstream_task_id: Optional[str] = None
    status: str
    prompt: str
    config: dict
    ref_images: Optional[list[str]] = None
    result_urls: Optional[list[str]] = None
    result_text: Optional[str] = None
    error: Optional[str] = None
    node_id: str
    created_at: datetime.datetime
    updated_at: datetime.datetime

    model_config = {"from_attributes": True}

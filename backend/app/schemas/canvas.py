import datetime
from typing import Optional

from pydantic import BaseModel


class CanvasProjectCreate(BaseModel):
    name: str = "Untitled"
    canvas_data: dict = {}


class CanvasProjectUpdate(BaseModel):
    name: Optional[str] = None
    canvas_data: Optional[dict] = None


class CanvasProjectOut(BaseModel):
    id: int
    user_id: Optional[int]
    name: str
    canvas_data: dict
    created_at: datetime.datetime
    updated_at: datetime.datetime

    model_config = {"from_attributes": True}


class CanvasProjectListItem(BaseModel):
    id: int
    name: str
    canvas_data: dict
    updated_at: datetime.datetime

    model_config = {"from_attributes": True}

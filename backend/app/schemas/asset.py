import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

# 前端 AssetType 定义（与 frontend/src/lib/types.ts 对齐）
AssetTypeValue = Literal["character", "scene", "object", "style", "audio", "other"]


# --- Folder ---

class AssetFolderCreate(BaseModel):
    name: str
    space_key: str = "personal"
    parent_id: Optional[int] = None


class AssetFolderUpdate(BaseModel):
    name: Optional[str] = None


class AssetFolderOut(BaseModel):
    id: int
    user_id: int
    name: str
    space_key: str
    parent_id: Optional[int]
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


# --- Asset ---

class AssetCreate(BaseModel):
    name: str = Field(default="Untitled", max_length=200)
    type: AssetTypeValue = "other"
    width: int = 0
    height: int = 0
    description: str = ""
    tags: list[str] = []
    extra_data: dict = {}
    folder_id: Optional[int] = None
    space_key: str = "personal"


class AssetUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    type: Optional[AssetTypeValue] = None
    width: Optional[int] = None
    height: Optional[int] = None
    description: Optional[str] = None
    tags: Optional[list[str]] = None
    folder_id: Optional[int] = None


class AssetOut(BaseModel):
    id: int
    user_id: int
    folder_id: Optional[int]
    space_key: str
    name: str
    type: str
    width: int
    height: int
    description: str
    tags: list
    extra_data: dict
    created_at: datetime.datetime
    updated_at: datetime.datetime

    model_config = {"from_attributes": True}

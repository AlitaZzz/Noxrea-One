from typing import Optional

from pydantic import BaseModel, Field


class ModelChannelCreate(BaseModel):
    """创建频道输入。"""
    name: str = Field(max_length=100)
    baseUrl: str = Field(max_length=500)
    apiKey: str = Field(default="", max_length=500)


class ModelChannelUpdate(BaseModel):
    """更新频道输入（所有字段可选）。"""
    name: Optional[str] = Field(default=None, max_length=100)
    baseUrl: Optional[str] = Field(default=None, max_length=500)
    apiKey: Optional[str] = Field(default=None, max_length=500)


class ModelInfoCreate(BaseModel):
    """添加单个模型输入。"""
    name: str = Field(max_length=200)
    capabilities: list[str] = []


class ModelModelsSet(BaseModel):
    """全量替换模型列表输入。"""
    models: list[ModelInfoCreate] = []


class ModelCapabilityUpdate(BaseModel):
    """更新模型能力列表输入。"""
    capabilities: list[str] = []

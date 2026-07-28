"""
GET /api/model-params - 返回所有模型的 params + defaults + constraints（不含 transforms）。

前端启动时拉取一次，缓存到 model-store。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.deps import get_current_user
from app.schemas.common import UnifiedResponse
from app.services.model_params import ModelParamsRegistry

router = APIRouter(tags=["model-params"])


@router.get("/api/model-params")
async def get_model_params(user=Depends(get_current_user)) -> UnifiedResponse:
    """返回所有模型的参数配置（params + defaults + constraints）。"""
    return UnifiedResponse(code=200, data=ModelParamsRegistry().get_public(), msg="ok")

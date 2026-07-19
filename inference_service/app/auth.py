"""API Key 鉴权依赖。"""

from fastapi import HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from app.config import settings

security = HTTPBearer(auto_error=False)


def verify_api_key(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    """验证 API Key（X-API-Key header 或 Bearer token）"""
    if not settings.API_KEY:
        # 未配置 Key = 开发模式，放行所有请求
        return True

    key = credentials.credentials if credentials else ""
    if key == settings.API_KEY:
        return True

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Invalid API key",
    )

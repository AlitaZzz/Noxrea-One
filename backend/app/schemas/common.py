from typing import Generic, TypeVar, Optional

from pydantic import BaseModel

T = TypeVar("T")


class UnifiedResponse(BaseModel, Generic[T]):
    code: int = 200
    data: Optional[T] = None
    msg: str = "ok"

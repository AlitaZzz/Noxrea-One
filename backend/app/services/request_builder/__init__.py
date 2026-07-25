"""request_builder —— 将 Internal Request 转换为 Provider Request 体。

执行顺序：mapping → transforms → patch
不涉及 HTTP 通信、端点构造、响应解析。
"""

from app.services.request_builder.engine import build

__all__ = ["build"]

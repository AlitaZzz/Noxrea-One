"""
轻量内存限流（滑动窗口）。

按 (ip, scope) 维护请求时间戳，超过窗口内最大次数返回 429。
- 仅适合单进程部署（多进程下计数不共享，需换 redis 等共享存储）。
- 不持久化，进程重启计数清零。
"""

import time
from collections import defaultdict
from threading import Lock

from fastapi import HTTPException, Request, status

# ip -> scope -> [timestamp, ...]
_buckets: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
_lock = Lock()


def _client_ip(request: Request) -> str:
    # 优先取反代后的真实 IP（若有），否则取连接 IP
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _prune(stamps: list[float], window_sec: int, now: float) -> list[float]:
    return [t for t in stamps if t > now - window_sec]


def rate_limit(scope: str, max_count: int, window_sec: int):
    """FastAPI 依赖：超限抛 429。

    用法：
        @router.post("/login", dependencies=[Depends(rate_limit("login", 10, 300))])
    """

    def dep(request: Request):
        ip = _client_ip(request)
        now = time.monotonic()
        with _lock:
            stamps = _prune(_buckets[ip][scope], window_sec, now)
            if len(stamps) >= max_count:
                _buckets[ip][scope] = stamps  # 保留窗口内记录便于后续判断
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"Too many requests, try again later (scope={scope})",
                )
            stamps.append(now)
            _buckets[ip][scope] = stamps

    return dep


def reset() -> None:
    """清空计数（测试用）。"""
    with _lock:
        _buckets.clear()

"""共享 httpx 配置。

提供场景化超时预设，替代一刀切全局超时。
所有预设均来自 settings（可通过 .env / 环境变量覆盖），按场景选择合适超时即可。
"""

import httpx

from app.config import settings

# ── 场景化超时预设 ──────────────────────────────────────────────
# 1. 下载 / CDN：connect 放宽给慢 CDN；总超时由外层 asyncio.wait_for 兜底
TIMEOUT_DOWNLOAD = httpx.Timeout(
    connect=settings.HTTP_DL_CONNECT,
    read=settings.HTTP_DL_READ,
    write=settings.HTTP_DL_WRITE,
    pool=settings.HTTP_DL_POOL,
)

# 2. 异步轮询：极短超时，失败快速重试而非卡住协程
TIMEOUT_POLL = httpx.Timeout(
    connect=settings.HTTP_POLL_CONNECT,
    read=settings.HTTP_POLL_READ,
    write=settings.HTTP_POLL_WRITE,
    pool=settings.HTTP_POLL_POOL,
)

# 3. 同步普通 API：/models, /chat/completions 等普通接口
TIMEOUT_API = httpx.Timeout(
    connect=settings.HTTP_API_CONNECT,
    read=settings.HTTP_API_READ,
    write=settings.HTTP_API_WRITE,
    pool=settings.HTTP_API_POOL,
)

# 4. 异步创建任务：POST 请求只提交任务，不等出图结果
TIMEOUT_ASYNC_CREATE = httpx.Timeout(
    connect=settings.HTTP_ASYNC_CONNECT,
    read=settings.HTTP_ASYNC_READ,
    write=settings.HTTP_ASYNC_WRITE,
    pool=settings.HTTP_ASYNC_POOL,
)

# 5. AI 生图/生视频（同步）：read 沿用 WORKER_API_TIMEOUT(240s)
TIMEOUT_AI_GENERATE = httpx.Timeout(
    connect=10,
    read=settings.WORKER_API_TIMEOUT,
    write=30,
    pool=10,
)

# 6. 推理服务（bg_removal 等）：总耗时由 HTTP_TIMEOUT_INFERENCE(300s) 兜底
TIMEOUT_INFERENCE = httpx.Timeout(
    connect=10,
    read=settings.HTTP_TIMEOUT_INFERENCE,
    write=40,
    pool=10,
)

# 向后兼容别名：旧代码引用的 HTTPX_TIMEOUT → 指向下载预设（原主要用途）
HTTPX_TIMEOUT = TIMEOUT_DOWNLOAD

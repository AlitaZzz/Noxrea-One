"""开发环境 mock 生图。

生产路径不加载：仅当 settings.MOCK_IMAGE_GENERATE 为真时，executor 才延迟 import 本模块。
位于 capabilities/mock/，属于开发测试能力，不放在 worker 中。
"""

import logging
import os

from app.models.task import GenerationTask
from app.services.storage import save_upload_bytes

logger = logging.getLogger(__name__)


async def process_mock_images(task: GenerationTask) -> None:
    """Mock 生图：跳过真实 AI，按前台设置的 n 返回对应张数测试图。"""
    from app.services.worker.executor import update_task_status

    config = task.config or {}
    n = max(1, min(4, int(config.get("n", 1) or 1)))
    urls = await _collect_mock_image_bytes(task.user_id, n)
    if urls:
        await update_task_status(task.id, "completed", result_urls=urls)
        logger.info(f"mock image done task={task.id} urls={len(urls)}")
    else:
        await update_task_status(task.id, "failed", error="mock 模式未找到可用测试图")


async def _collect_mock_image_bytes(user_id: int, count: int = 1) -> list[str]:
    """从 uploads 目录挑内容不同的真实图片，落本地存储并返回公开 URL。"""
    from app.services.media import UPLOAD_DIR

    candidates: list[str] = []
    for root, _, files in os.walk(UPLOAD_DIR):
        for fn in files:
            if fn.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
                candidates.append(os.path.join(root, fn))
        if len(candidates) >= 50:
            break

    unique: list[bytes] = []
    seen: set[bytes] = set()
    for path in candidates:
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            continue
        if data in seen:
            continue
        seen.add(data)
        unique.append(data)
        if len(unique) >= 50:
            break

    if not unique:
        return []

    chosen = [unique[i % len(unique)] for i in range(count)]

    urls: list[str] = []
    for data in chosen:
        url = await save_upload_bytes(user_id=user_id, content=data, category="generated")
        if url:
            urls.append(url)
    return urls

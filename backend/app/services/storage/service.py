"""
StorageService - 资源存储编排层（供 worker/executor 调用）。

纯编排，不包含实际逻辑：
- download_and_save / batch_download_and_save -> download.py
- save_bytes -> download.py -> persist.py

依赖方向：service -> download -> persist（单向链路，不跨层）。
"""

from __future__ import annotations

import asyncio
import logging

from .download import download_and_save as _download_and_save
from .download import save_bytes as _save_bytes

logger = logging.getLogger(__name__)


class StorageService:
    """存储服务：下载资源并落本地/对象存储。

    纯编排层，所有实际逻辑在 download.py（下载+落盘）和 persist.py（落盘+去重）。
    依赖方向：service -> download -> persist（单向，不跨层）。
    """

    @staticmethod
    async def download_and_save(
        cdn_url: str,
        user_id: int,
        capability: str,
        task_id: str = "",
    ) -> str | None:
        """从 CDN 下载资源并保存，返回本地 URL。"""
        return await _download_and_save(cdn_url, user_id, capability, task_id)

    @staticmethod
    async def save_bytes(
        content: bytes,
        user_id: int,
        ext: str = "png",
        category: str = "generated",
    ) -> str | None:
        """直接存储 bytes 内容（不经下载）。"""
        return await _save_bytes(content, user_id, ext=ext, category=category)

    @staticmethod
    async def batch_download_and_save(
        urls: list[str],
        user_id: int,
        capability: str,
        task_id: str = "",
    ) -> list[str]:
        """批量下载并保存多个 URL，并发下载，失败不计入结果。"""
        async def _fetch_one(url: str) -> str | None:
            return await StorageService.download_and_save(url, user_id, capability, task_id)

        tasks = [asyncio.create_task(_fetch_one(u)) for u in urls]
        results: list[str] = []
        for t in asyncio.as_completed(tasks):
            local = await t
            if local:
                results.append(local)
        return results

"""
StorageService — 资源存储服务。

包装 storage.py 的 save_upload_bytes，提供统一的资源下载+落盘入口。

未来可扩展为 Storage 接口 + 多种后端实现（本地 / MinIO / OSS / S3）。

架构隔离：Storage 不感知生成类型（image/video/audio），只关心字节流存储。
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from app.config import settings
from app.services.storage import save_upload_bytes
from app.services import ssrf
from app.services.http import HTTPX_TIMEOUT

logger = logging.getLogger(__name__)

# ── 复用 base.py 中的下载逻辑（已稳定，不重复造轮子）──
from app.services.storage.download import download_and_save as _download_and_save


class StorageService:
    """存储服务：下载资源并落本地/对象存储。

    当前实现复用 download_and_save（本地存储 + SHA256 去重），
    后续可替换为 MinIO / OSS / S3。
    """

    @staticmethod
    async def download_and_save(
        cdn_url: str,
        user_id: int,
        capability: str,
        task_id: str = "",
    ) -> str | None:
        """从 CDN 下载资源并保存，返回本地 URL。

        Args:
            cdn_url: 上游返回的资源 URL
            user_id: 用户 ID
            capability: 能力类型（image/video/audio，用于日志和类型推断）
            task_id: 任务 ID（日志用）

        Returns:
            本地 URL，失败返回 None
        """
        # 复用经过充分验证的下载+存储逻辑
        return await _download_and_save(cdn_url, user_id, capability, task_id)

    @staticmethod
    async def save_bytes(
        content: bytes,
        user_id: int,
        ext: str = "png",
        category: str = "generated",
    ) -> str | None:
        """直接存储 bytes 内容。"""
        return await save_upload_bytes(
            user_id=user_id,
            content=content,
            category=category,
            ext=ext,
        )

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

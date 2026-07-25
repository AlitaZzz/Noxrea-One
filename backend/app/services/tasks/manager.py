"""
TaskManager — 任务生命周期管理。

负责：
- ✓ 同步优先异步兜底结果提取
- ✓ 自动轮询（使用 Protocol 的 build_poll_url + parse_poll_response）
- ✓ 任务状态更新
- ✓ 事件发布

架构隔离：TaskManager 不感知具体模型、不感知厂商。
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import httpx

from app.config import settings
from app.crud import task as crud_task
from app.database import async_session
from app.schemas.result import AsyncSubmission, GenerationResult, PollResult
from app.services.protocols.base import BaseProtocol, PENDING_STATUSES
from app.services.events.bus import event_bus
from app.services.events.types import EventType, TaskEvent
from app.services.http import TIMEOUT_POLL, TIMEOUT_AI_GENERATE

logger = logging.getLogger(__name__)

# ── 异步轮询默认参数 ─────────────────────────────────────────
DEFAULT_POLL_INTERVAL: float = getattr(settings, "WORKER_ASYNC_POLL_INTERVAL", 3.0)
DEFAULT_MAX_ATTEMPTS: int = getattr(settings, "WORKER_ASYNC_POLL_MAX_ATTEMPTS", 60)
DEFAULT_INITIAL_DELAY: float = getattr(settings, "WORKER_ASYNC_POLL_INITIAL_DELAY", 0.0)


class TaskManager:
    """统一任务管理器。

    同步优先，异步兜底：
    1. 先尝试 protocol.extract_result() → 成功则直接完成
    2. 失败则尝试 protocol.extract_task_id() → 存在则进入轮询
    3. 两者都无则失败
    """

    @staticmethod
    async def submit_and_wait(
        *,
        task_id: str,
        user_id: int,
        protocol: BaseProtocol,
        capability: str,
        base_url: str,
        api_key: str,
        endpoint: str,
        headers: dict,
        body: dict,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        max_poll_attempts: int = DEFAULT_MAX_ATTEMPTS,
        initial_delay: float = DEFAULT_INITIAL_DELAY,
    ) -> dict:
        """同步优先异步兜底：提交上游请求，自动判断/轮询。

        Returns:
            {
                "status": "completed" | "failed",
                "urls": [...],
                "files": [...],  # raw bytes（如 TTS）
                "error": "...",
                "metadata": {...},
            }
        """
        # 1. 提交上游请求
        try:
            logger.info(
                f"[taskmgr] task={task_id} http POST -> {endpoint} "
                f"protocol={protocol.protocol_name} capability={capability}"
            )
            async with httpx.AsyncClient(timeout=TIMEOUT_AI_GENERATE) as client:
                resp = await asyncio.wait_for(
                    client.post(endpoint, json=body, headers=headers),
                    timeout=settings.WORKER_API_TIMEOUT,
                )

            if not resp.is_success:
                # HTTP 错误：尝试从错误响应提取 task_id
                try:
                    err_data = resp.json()
                except Exception:
                    err_data = {}
                task_id_extracted = protocol.extract_task_id(err_data)
                if task_id_extracted:
                    # 进入轮询前先检查是否已被取消
                    if await TaskManager._check_cancelled(task_id):
                        return {
                            "status": "failed",
                            "urls": [],
                            "error": "Cancelled",
                            "metadata": {},
                        }
                    return await TaskManager._poll(
                        task_id=task_id,
                        user_id=user_id,
                        protocol=protocol,
                        capability=capability,
                        base_url=base_url,
                        api_key=api_key,
                        upstream_task_id=task_id_extracted,
                        poll_interval=poll_interval,
                        max_poll_attempts=max_poll_attempts,
                        initial_delay=initial_delay,
                    )
                return {
                    "status": "failed",
                    "urls": [],
                    "error": f"Upstream returned HTTP {resp.status_code}",
                    "metadata": {},
                }

            # 二进制响应（如 TTS 返回 audio/mpeg）→ 直接返回 bytes
            content_type = resp.headers.get("content-type", "")
            if _is_binary_response(content_type, body):
                ext = _infer_ext(content_type)
                logger.info(f"[taskmgr] task={task_id} binary response content_type={content_type} size={len(resp.content)}")
                return {
                    "status": "completed",
                    "urls": [],
                    "files": [(resp.content, ext)],
                    "metadata": {},
                }

            data = resp.json()
        except asyncio.TimeoutError:
            return {
                "status": "failed",
                "urls": [],
                "error": "API call timed out",
                "metadata": {},
            }
        except Exception as e:
            return {
                "status": "failed",
                "urls": [],
                "error": str(e)[:500],
                "metadata": {},
            }

        # 2. 尝试同步提结果
        result = protocol.extract_result(data, capability)
        if result and not result.is_empty:
            return {
                "status": "completed",
                "urls": result.urls,
                "files": result.files,
                "metadata": result.metadata,
            }

        # 3. 尝试提取异步 task_id → 进入轮询
        upstream_task_id = protocol.extract_task_id(data)
        if upstream_task_id:
            logger.info(f"TaskManager async detected task={task_id} upstream_id={upstream_task_id}")
            # 进入轮询前先检查是否已被取消
            if await TaskManager._check_cancelled(task_id):
                return {
                    "status": "failed",
                    "urls": [],
                    "error": "Cancelled",
                    "metadata": {},
                }
            return await TaskManager._poll(
                task_id=task_id,
                user_id=user_id,
                protocol=protocol,
                capability=capability,
                base_url=base_url,
                api_key=api_key,
                upstream_task_id=upstream_task_id,
                poll_interval=poll_interval,
                max_poll_attempts=max_poll_attempts,
                initial_delay=initial_delay,
            )

        # 4. 两者都无 → 失败
        logger.warning(f"TaskManager no result task={task_id} keys={list(data.keys())}")
        return {
            "status": "failed",
            "urls": [],
            "error": "Upstream returned neither result nor task_id",
            "metadata": {"raw_keys": list(data.keys())},
        }

    @staticmethod
    async def poll_existing(
        *,
        task_id: str,
        user_id: int,
        protocol: BaseProtocol,
        capability: str,
        base_url: str,
        api_key: str,
        upstream_task_id: str,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        max_poll_attempts: int = DEFAULT_MAX_ATTEMPTS,
    ) -> dict:
        """对已有 upstream_task_id 的任务执行轮询。"""
        return await TaskManager._poll(
            task_id=task_id,
            user_id=user_id,
            protocol=protocol,
            capability=capability,
            base_url=base_url,
            api_key=api_key,
            upstream_task_id=upstream_task_id,
            poll_interval=poll_interval,
            max_poll_attempts=max_poll_attempts,
        )

    # ── 内部轮询 ──────────────────────────────────────────

    @staticmethod
    async def _check_cancelled(task_id: str) -> bool:
        """检查任务是否已被用户取消。"""
        try:
            from sqlalchemy import select
            from app.models.task import GenerationTask
            async with async_session() as db:
                cur = await db.execute(
                    select(GenerationTask.status, GenerationTask.error).where(
                        GenerationTask.id == task_id
                    )
                )
                row = cur.fetchone()
                if row and row[0] == "failed" and row[1] == "Cancelled":
                    return True
        except Exception:
            pass
        return False

    @staticmethod
    async def _poll(
        task_id: str,
        user_id: int,
        protocol: BaseProtocol,
        capability: str,
        base_url: str,
        api_key: str,
        upstream_task_id: str,
        poll_interval: float,
        max_poll_attempts: int,
        initial_delay: float = 0.0,
    ) -> dict:
        """执行异步轮询。"""
        poll_url = protocol.build_poll_url(base_url, upstream_task_id)
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        # 保存 upstream_task_id 到 DB
        await TaskManager._update_upstream(task_id, upstream_task_id)

        # 初始等待
        if initial_delay > 0:
            await asyncio.sleep(initial_delay)

        # 轮询循环（TaskManager 负责 while/sleep，Protocol 不负责）
        for attempt in range(max_poll_attempts):
            # 自适应间隔：前 60 次用初始间隔，之后翻倍（给慢 Provider 更多时间）
            delay = poll_interval * 2 if attempt >= 60 else poll_interval
            await asyncio.sleep(delay)
            # 每 5 次检查是否已被取消
            if attempt % 5 == 0:
                if await TaskManager._check_cancelled(task_id):
                    logger.info(f"poll cancelled by user task={task_id} attempt={attempt+1}")
                    return {
                        "status": "failed",
                        "urls": [],
                        "error": "Cancelled",
                        "metadata": {},
                    }
            # 每 10 次打印进度
            if attempt % 10 == 0:
                logger.info(f"polling task={task_id} attempt={attempt+1}/{max_poll_attempts} upstream_id={upstream_task_id}")
            try:
                async with httpx.AsyncClient(timeout=TIMEOUT_POLL) as client:
                    poll_resp = await client.get(poll_url, headers=headers)

                if not poll_resp.is_success:
                    logger.warning(f"poll bad status task={task_id} attempt={attempt+1}/{max_poll_attempts} status={poll_resp.status_code}")
                    # 不立即失败，可能上游网关超时但任务还在跑
                    continue

                poll_data = poll_resp.json()
                logger.info(f"poll task={task_id} attempt={attempt+1} body={poll_data}")
                parsed: PollResult = protocol.parse_poll_response(poll_data, capability)

                if parsed.status == "completed":
                    logger.info(f"poll completed task={task_id} attempt={attempt+1}")
                    return {
                        "status": "completed",
                        "urls": parsed.urls,
                        "files": parsed.files,
                        "metadata": parsed.metadata,
                    }
                elif parsed.status == "failed":
                    logger.warning(f"poll failed task={task_id} attempt={attempt+1} err={parsed.error}")
                    return {
                        "status": "failed",
                        "urls": [],
                        "error": parsed.error or "上游任务执行失败",
                        "metadata": {},
                    }
                # else: pending, continue polling

            except asyncio.TimeoutError:
                logger.warning(f"poll timeout task={task_id} attempt={attempt+1}")
            except Exception as e:
                logger.warning(f"poll error task={task_id} attempt={attempt+1} err={str(e)[:120]}")

        # 超时
        return {
            "status": "failed",
            "urls": [],
            "error": f"异步轮询超时（upstream_task_id={upstream_task_id}）",
            "metadata": {},
        }

    @staticmethod
    async def _update_upstream(task_id: str, upstream_task_id: str) -> None:
        """保存 upstream_task_id 到 DB。"""
        try:
            async with async_session() as db:
                from sqlalchemy import update as _update
                from app.models.task import GenerationTask
                await db.execute(
                    _update(GenerationTask)
                    .where(GenerationTask.id == task_id)
                    .values(upstream_task_id=upstream_task_id, updated_at=datetime.now(timezone.utc))
                )
                await db.commit()
        except Exception:
            pass  # 非关键路径

    # ── 事件发布 ──────────────────────────────────────────

    @staticmethod
    async def emit(event_type: EventType, task_id: str, user_id: int, capability: str, **data) -> None:
        """发布任务事件。"""
        try:
            await event_bus.publish(TaskEvent(
                event_type=event_type,
                task_id=task_id,
                user_id=user_id,
                capability=capability,
                data=data,
            ))
        except Exception:
            pass  # 事件发布失败不影响主流程


# ── 工具函数 ──────────────────────────────────────────────────

def _is_binary_response(content_type: str, body: dict) -> bool:
    """判断是否为二进制响应（TTS 返回 audio bytes）。"""
    if "audio" in content_type or "video" in content_type:
        return True
    if body.get("_audio_mode") == "tts" and ("octet-stream" in content_type or not content_type):
        return True
    return False


def _infer_ext(content_type: str) -> str:
    """根据 content-type 推断文件扩展名。"""
    if "mp3" in content_type or "mpeg" in content_type:
        return "mp3"
    if "wav" in content_type:
        return "wav"
    if "ogg" in content_type or "opus" in content_type:
        return "ogg"
    if "aac" in content_type:
        return "aac"
    if "flac" in content_type:
        return "flac"
    return "mp3"

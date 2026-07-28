"""
EventBus - 事件总线。

支持异步事件发布/订阅，用于 SSE 推送任务状态变更给 Canvas 前端。

使用 asyncio.Queue 模式：每个订阅者建立独立的事件队列，
publish 时广播到该 task_id 的所有订阅者队列（支持多标签页同时监听同一任务）。
"""

from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator

from app.services.events.types import TaskEvent

logger = logging.getLogger(__name__)


class EventBus:
    """基于 asyncio.Queue 的事件总线，支持同一 task_id 的多订阅者。

    用法一（SSE 端点，带超时和断开检测）::

        queue = await bus.ensure_queue("task_123")
        try:
            evt = await bus.wait_event(queue, timeout=5.0)
            ...
        finally:
            await bus.unsubscribe("task_123", queue)

    用法二（async iterator）::

        async for event in bus.subscribe("task_123"):
            ...

    订阅者在任务完成后应调用 unsubscribe() 清理队列。
    """

    def __init__(self):
        self._subscribers: dict[str, list[asyncio.Queue[TaskEvent | None]]] = {}
        self._lock = asyncio.Lock()

    async def ensure_queue(self, task_id: str) -> asyncio.Queue[TaskEvent | None]:
        """创建订阅者队列并返回。

        在查询 DB 之前调用，防止 emit 在 subscribe 之间丢失事件。
        每次调用创建独立队列，支持同一 task_id 的多订阅者。
        """
        async with self._lock:
            if task_id not in self._subscribers:
                self._subscribers[task_id] = []
            q: asyncio.Queue[TaskEvent | None] = asyncio.Queue()
            self._subscribers[task_id].append(q)
            return q

    async def publish(self, event: TaskEvent) -> None:
        """发布事件到指定 task_id 的所有订阅者。"""
        async with self._lock:
            queues = list(self._subscribers.get(event.task_id, []))
        if not queues:
            logger.debug(f"EventBus: no subscriber for task_id={event.task_id}")
            return
        for q in queues:
            await q.put(event)

    async def wait_event(
        self, queue: asyncio.Queue[TaskEvent | None], timeout: float = 5.0
    ) -> TaskEvent | None:
        """等待事件，超时返回 None。

        用于 SSE 端点周期性检测客户端断开：
        每次最多阻塞 timeout 秒，返回事件或 None（超时）。
        """
        try:
            return await asyncio.wait_for(queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None

    async def subscribe(self, task_id: str) -> AsyncIterator[TaskEvent]:
        """订阅指定 task_id 的事件流。

        返回异步迭代器，可配合 SSE 推送给前端。
        收到 None 哨兵后迭代结束（对应任务完成/失败）。
        """
        queue = await self.ensure_queue(task_id)
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield event
        finally:
            await self.unsubscribe(task_id, queue)

    async def send_end(self, task_id: str) -> None:
        """发送结束哨兵：通知订阅者任务事件流结束。"""
        async with self._lock:
            queues = list(self._subscribers.get(task_id, []))
        for q in queues:
            await q.put(None)

    async def unsubscribe(self, task_id: str, queue: asyncio.Queue) -> None:
        """移除订阅者队列。当 task_id 无订阅者时自动清理。"""
        async with self._lock:
            if task_id in self._subscribers:
                try:
                    self._subscribers[task_id].remove(queue)
                except ValueError:
                    pass
                if not self._subscribers[task_id]:
                    del self._subscribers[task_id]


# 全局单例
event_bus = EventBus()

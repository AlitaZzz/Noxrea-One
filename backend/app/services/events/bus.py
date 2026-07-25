"""
EventBus — 事件总线。

支持异步事件发布/订阅，用于 TaskManager 通知 SSE/WebSocket 推送任务状态变更给 Canvas 前端。

使用 asyncio.Queue 模式：每个任务建立一个事件队列，订阅者调用 subscribe(task_id) 获取队列。
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import AsyncIterator

from app.services.events.types import TaskEvent

logger = logging.getLogger(__name__)


class EventBus:
    """基于 asyncio.Queue 的简易事件总线。

    用法：
        bus = EventBus()
        await bus.publish(event)

        async for event in bus.subscribe("task_123"):
            # process event
            ...

    订阅者在任务完成后应调用 unsubscribe() 清理队列。
    """

    def __init__(self):
        self._queues: dict[str, asyncio.Queue[TaskEvent | None]] = {}
        self._lock = asyncio.Lock()

    async def publish(self, event: TaskEvent) -> None:
        """发布事件到指定 task_id 的队列。"""
        async with self._lock:
            queue = self._queues.get(event.task_id)
        if queue:
            await queue.put(event)
        else:
            logger.debug(f"EventBus: no subscriber for task_id={event.task_id}")

    async def subscribe(self, task_id: str) -> AsyncIterator[TaskEvent]:
        """订阅指定 task_id 的事件流。

        返回异步迭代器，可配合 SSE 推送给前端。
        收到 None 哨兵后迭代结束（对应任务完成/失败）。
        """
        async with self._lock:
            if task_id not in self._queues:
                self._queues[task_id] = asyncio.Queue()
            queue = self._queues[task_id]

        while True:
            event = await queue.get()
            if event is None:
                break
            yield event

    async def send_end(self, task_id: str) -> None:
        """发送结束哨兵：通知订阅者任务事件流结束。"""
        async with self._lock:
            queue = self._queues.get(task_id)
        if queue:
            await queue.put(None)

    async def unsubscribe(self, task_id: str) -> None:
        """取消订阅并清理队列。"""
        async with self._lock:
            self._queues.pop(task_id, None)


# 全局单例
event_bus = EventBus()

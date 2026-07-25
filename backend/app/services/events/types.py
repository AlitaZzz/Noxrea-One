"""
Event types for the AI Gateway event system.

TaskManager 通过 EventBus 发布任务状态变更事件，
SSE/WebSocket 订阅并将事件推送给 Canvas 前端。
"""

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class EventType(StrEnum):
    TASK_CREATED = "task_created"
    TASK_PROCESSING = "task_processing"
    TASK_PROGRESS = "task_progress"
    TASK_COMPLETED = "task_completed"
    TASK_FAILED = "task_failed"


@dataclass
class TaskEvent:
    """任务事件数据类。"""
    event_type: EventType
    task_id: str
    user_id: int
    capability: str = ""
    data: dict[str, Any] = field(default_factory=dict)

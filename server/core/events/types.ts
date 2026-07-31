// ── 事件类型定义（对应 backend/app/services/events/types.py） ──

export enum EventType {
  TASK_COMPLETED = "TASK_COMPLETED",
  TASK_FAILED = "TASK_FAILED",
  TASK_PROGRESS = "TASK_PROGRESS",
}

export interface TaskEvent {
  type: EventType;
  taskId: string;
  status: "completed" | "failed" | "processing";
  resultUrls?: string[];
  resultText?: string;
  error?: string;
  prompt?: string;
  timestamp: string;
}

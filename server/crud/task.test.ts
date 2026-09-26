import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  logEvent: vi.fn(),
  publishTaskTerminal: vi.fn(),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    generationTask: {
      updateMany: mocks.updateMany,
    },
  },
}));
vi.mock("@server/services/tasks/event-bus", () => ({
  publishTaskTerminal: mocks.publishTaskTerminal,
}));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: mocks.logEvent,
  errText: (err: unknown) => String(err),
}));

import { touchTaskHeartbeat } from "./task";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("touchTaskHeartbeat", () => {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");

  it("守卫命中时返回所有权仍存在", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(touchTaskHeartbeat("task-1", startedAt)).resolves.toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "processing", startedAt },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it("守卫未命中时返回所有权丢失", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(touchTaskHeartbeat("task-1", startedAt)).resolves.toBe(false);
  });

  it("数据库错误不误判为所有权丢失，记录日志后继续轮询", async () => {
    mocks.updateMany.mockRejectedValue(new Error("db unavailable"));

    await expect(touchTaskHeartbeat("task-1", startedAt)).resolves.toBe(true);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "task",
      expect.objectContaining({ stage: "heartbeat_write_failed", taskId: "task-1" }),
    );
  });
});

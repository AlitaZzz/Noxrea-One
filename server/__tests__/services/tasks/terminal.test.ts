/**
 * 任务终态用例测试（specs/server-crud-service-boundary.md 规则 4）。
 * 锁定：写库成功后才广播、守卫未命中不广播、写库异常由 safe 变体兜底，
 * 以及事件 payload 直接来自本次写入返回行（不做二次重读）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeTaskTerminal: vi.fn(),
  publishTaskTerminal: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@server/crud/task", () => ({
  writeTaskTerminal: mocks.writeTaskTerminal,
}));
vi.mock("@server/services/tasks/event-bus", () => ({
  publishTaskTerminal: mocks.publishTaskTerminal,
}));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: mocks.logEvent,
  errText: (err: unknown) => String(err),
}));

import { isTerminalTaskStatus } from "@noxrea/shared";
import {
  cancelTask,
  safeCompleteTask,
  safeFailTask,
  toTerminalState,
} from "@server/services/tasks/terminal";

const STARTED_AT = new Date("2026-01-01T00:00:00.000Z");

function makeTerminalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    status: "completed",
    resultUrls: ["k1"],
    resultText: "done",
    error: null,
    errorCode: null,
    prompt: "p",
    config: { providerId: 1 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("安全变体（写库 + 广播 + 兜底）", () => {
  it("写库成功 → 广播本次写入行映射的 payload，且广播发生在写库完成之后", async () => {
    let resolveWrite!: (value: unknown) => void;
    mocks.writeTaskTerminal.mockReturnValue(
      new Promise((resolve) => {
        resolveWrite = resolve;
      })
    );

    const pending = safeCompleteTask("task-1", { resultUrls: ["k1"], resultText: "done" }, STARTED_AT);

    expect(mocks.publishTaskTerminal).not.toHaveBeenCalled();
    const row = makeTerminalRow();
    resolveWrite(row);
    await expect(pending).resolves.toBe(row);

    expect(mocks.writeTaskTerminal).toHaveBeenCalledWith(
      "task-1",
      "completed",
      { resultUrls: ["k1"], resultText: "done" },
      STARTED_AT
    );
    expect(mocks.publishTaskTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.publishTaskTerminal).toHaveBeenCalledWith(toTerminalState(row));
    expect(mocks.writeTaskTerminal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publishTaskTerminal.mock.invocationCallOrder[0]
    );
  });

  it("守卫未命中（null）→ 不广播、不重试，记 skipped_terminal_write", async () => {
    mocks.writeTaskTerminal.mockResolvedValue(null);

    await expect(
      safeFailTask("task-1", { error: "x", errorCode: "e" }, STARTED_AT)
    ).resolves.toBeNull();

    expect(mocks.publishTaskTerminal).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent).toHaveBeenCalledWith("task", {
      stage: "skipped_terminal_write",
      taskId: "task-1",
    });
    expect(mocks.writeTaskTerminal).toHaveBeenCalledTimes(1);
  });

  it("写库异常 → 返回 null、不广播，记 terminal_write_failed（error 级别）", async () => {
    mocks.writeTaskTerminal.mockRejectedValue(new Error("db unavailable"));

    await expect(
      safeCompleteTask("task-1", { resultText: "done" }, STARTED_AT)
    ).resolves.toBeNull();

    expect(mocks.publishTaskTerminal).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith("task", {
      level: "error",
      stage: "terminal_write_failed",
      taskId: "task-1",
      error: "Error: db unavailable",
    });
  });

  it("广播抛错 → 终态仍返回，记录 terminal_broadcast_failed 而非写库失败", async () => {
    const row = makeTerminalRow();
    mocks.writeTaskTerminal.mockResolvedValue(row);
    mocks.publishTaskTerminal.mockImplementationOnce(() => {
      throw new Error("listener boom");
    });

    await expect(
      safeCompleteTask("task-1", { resultUrls: ["k1"], resultText: "done" }, STARTED_AT)
    ).resolves.toBe(row);

    expect(mocks.logEvent).toHaveBeenCalledWith("task", {
      level: "error",
      stage: "terminal_broadcast_failed",
      taskId: "task-1",
      error: "Error: listener boom",
    });
    expect(mocks.logEvent).not.toHaveBeenCalledWith(
      "task",
      expect.objectContaining({ stage: "terminal_write_failed" })
    );
  });
});

describe("cancelTask（用户取消终态）", () => {
  it("以 cancelled + 固定错误码写库，成功后广播", async () => {
    const row = makeTerminalRow({
      status: "cancelled",
      resultUrls: [],
      resultText: null,
      error: "Task cancelled by user",
      errorCode: "generation.cancelled",
    });
    mocks.writeTaskTerminal.mockResolvedValue(row);

    await expect(cancelTask("task-1")).resolves.toBe(row);

    expect(mocks.writeTaskTerminal).toHaveBeenCalledWith(
      "task-1",
      "cancelled",
      { error: "Task cancelled by user", errorCode: "generation.cancelled" },
      null
    );
    expect(mocks.publishTaskTerminal).toHaveBeenCalledWith(toTerminalState(row));
  });

  it("守卫未命中（已终态）→ 不广播", async () => {
    mocks.writeTaskTerminal.mockResolvedValue(null);

    await expect(cancelTask("task-1")).resolves.toBeNull();
    expect(mocks.publishTaskTerminal).not.toHaveBeenCalled();
  });
});

describe("终态投影与判定", () => {
  it("toTerminalState 保留 8 个事件字段，空 prompt 归一为 undefined", () => {
    const state = toTerminalState(
      makeTerminalRow({
        status: "failed",
        resultUrls: [],
        resultText: null,
        error: "boom",
        errorCode: "generation.failed",
        prompt: "",
      })
    );

    expect(state).toEqual({
      taskId: "task-1",
      status: "failed",
      resultUrls: [],
      resultText: undefined,
      error: "boom",
      errorCode: "generation.failed",
      prompt: undefined,
      config: { providerId: 1 },
    });
  });

  it("isTerminalTaskStatus 只认三个终态", () => {
    expect(isTerminalTaskStatus("completed")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("cancelled")).toBe(true);
    expect(isTerminalTaskStatus("pending")).toBe(false);
    expect(isTerminalTaskStatus("processing")).toBe(false);
  });
});

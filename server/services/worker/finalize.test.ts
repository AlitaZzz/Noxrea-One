/**
 * 终态编排单源回归测试。
 * 锁定：下载成功/部分成功/全失败/空结果/已取消/终态守卫拒绝六条路径，
 * 以及 executor 与 resume-polling 共用后的语义一致性。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTaskStatus: vi.fn(),
  safeCompleteTask: vi.fn(),
  safeFailTask: vi.fn(),
  touchTaskHeartbeat: vi.fn(),
  downloadAndSave: vi.fn(),
}));

vi.mock("@server/crud/task", () => ({
  getTaskStatus: mocks.getTaskStatus,
  safeCompleteTask: mocks.safeCompleteTask,
  safeFailTask: mocks.safeFailTask,
  touchTaskHeartbeat: mocks.touchTaskHeartbeat,
  TASK_HEARTBEAT_INTERVAL_MS: 30_000,
}));
vi.mock("@server/services/storage/download", () => ({
  downloadAndSave: mocks.downloadAndSave,
}));

import { finalizeGeneratedResult } from "./download-results";

const startedAt = new Date("2026-09-27T00:00:00Z");

function input(overrides: Partial<Parameters<typeof finalizeGeneratedResult>[0]> = {}) {
  return {
    taskId: "task-1",
    userId: 1,
    startedAt,
    urls: ["http://cdn.test/a.png", "http://cdn.test/b.png"],
    text: undefined as string | undefined,
    logLabel: "download failed",
    logChannel: "executor",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTaskStatus.mockResolvedValue("processing");
});

describe("finalizeGeneratedResult", () => {
  it("全部下载成功 → safeCompleteTask 携带产物与文本", async () => {
    mocks.downloadAndSave.mockImplementation(async (_url: string, _uid: number, _tid: string, key: string) => key);
    // downloadAndSave 实际签名 (cdnUrl, userId, taskId)——按 url 映射产物 key
    mocks.downloadAndSave.mockImplementation(async (url: string) => (url.endsWith("a.png") ? "u1/aa/a" : "u1/bb/b"));
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    const ok = await finalizeGeneratedResult(input({ text: "caption" }));

    expect(ok).toBe(true);
    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: ["u1/aa/a", "u1/bb/b"], resultText: "caption" },
      { startedAt }
    );
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("上游有产物但全部下载失败 → 显式 failTask download_failed", async () => {
    mocks.downloadAndSave.mockRejectedValue(new Error("network down"));
    mocks.safeFailTask.mockResolvedValue({ id: "task-1" });

    const ok = await finalizeGeneratedResult(input());

    expect(ok).toBe(false);
    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      { error: "生成结果下载失败", errorCode: "generation.download_failed" },
      { startedAt }
    );
    expect(mocks.safeCompleteTask).not.toHaveBeenCalled();
  });

  it("部分下载成功 → completed 只含成功产物", async () => {
    mocks.downloadAndSave.mockImplementation(async (url: string) =>
      url.endsWith("a.png") ? "u1/aa/a" : null
    );
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    const ok = await finalizeGeneratedResult(input());

    expect(ok).toBe(true);
    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: ["u1/aa/a"], resultText: undefined },
      { startedAt }
    );
  });

  it("上游无产物（URL 空列表）→ 空结果 completed（对齐旧 executor 行为）", async () => {
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    const ok = await finalizeGeneratedResult(input({ urls: [] }));

    expect(ok).toBe(true);
    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: [], resultText: undefined },
      { startedAt }
    );
    expect(mocks.downloadAndSave).not.toHaveBeenCalled();
  });

  it("下载前发现已取消 → 不下载不写终态", async () => {
    mocks.getTaskStatus.mockResolvedValue("cancelled");

    const ok = await finalizeGeneratedResult(input());

    expect(ok).toBe(false);
    expect(mocks.downloadAndSave).not.toHaveBeenCalled();
    expect(mocks.safeCompleteTask).not.toHaveBeenCalled();
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("终态写入被守卫拒绝（返回 null）→ 返回 false 不抛错", async () => {
    mocks.downloadAndSave.mockResolvedValue("u1/aa/a");
    mocks.safeCompleteTask.mockResolvedValue(null);

    const ok = await finalizeGeneratedResult(input({ urls: ["http://cdn.test/a.png"] }));

    expect(ok).toBe(false);
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });
});

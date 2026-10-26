/**
 * 终态编排单源回归测试。
 * 锁定：下载成功/部分成功/全失败/空结果/已取消/终态守卫拒绝六条路径，
 * 以及 executor 与 poll-attempt 共用后的语义一致性。
 * 另锁定产物身份收口（specs/generation-artifact-identity.md 规则 4–6）：
 * 重复候选与同字节多表示只产生一条结果，且只落盘一次。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTaskStatus: vi.fn(),
  safeCompleteTask: vi.fn(),
  safeFailTask: vi.fn(),
  touchTaskHeartbeat: vi.fn(),
  fetchMediaBytes: vi.fn(),
  identifyMediaBytes: vi.fn(),
  persistMediaBytes: vi.fn(),
}));

vi.mock("@server/crud/task", () => ({
  getTaskStatus: mocks.getTaskStatus,
  safeCompleteTask: mocks.safeCompleteTask,
  safeFailTask: mocks.safeFailTask,
  touchTaskHeartbeat: mocks.touchTaskHeartbeat,
  TASK_HEARTBEAT_INTERVAL_MS: 30_000,
}));
vi.mock("@server/services/storage/download", () => ({
  fetchMediaBytes: mocks.fetchMediaBytes,
  identifyMediaBytes: mocks.identifyMediaBytes,
  persistMediaBytes: mocks.persistMediaBytes,
}));

import { finalizeGeneratedResult } from "@server/services/worker/download-results";

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

/** 候选 → 字节：默认按 URL 最后一段取内容（a.png → "a"） */
function bytesByUrl(url: string): Buffer {
  return Buffer.from(url.split("/").pop() ?? "");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getTaskStatus.mockResolvedValue("processing");
  // 身份 = 字节内容（等价于真实实现里的内容哈希）
  mocks.fetchMediaBytes.mockImplementation(async (url: string) => bytesByUrl(url));
  mocks.identifyMediaBytes.mockImplementation(async (buffer: Buffer) => ({
    key: `u1/${buffer.toString()}`,
    hash: buffer.toString(),
    mimeType: "image/png",
    ext: ".png",
  }));
  mocks.persistMediaBytes.mockResolvedValue(undefined);
});

describe("finalizeGeneratedResult", () => {
  it("全部下载成功 → safeCompleteTask 携带产物与文本（首现顺序）", async () => {
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    const ok = await finalizeGeneratedResult(input({ text: "caption" }));

    expect(ok).toBe(true);
    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: ["u1/a.png", "u1/b.png"], resultText: "caption" },
      { startedAt }
    );
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("上游有产物但全部下载失败 → 显式 failTask download_failed", async () => {
    mocks.fetchMediaBytes.mockResolvedValue(null);
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
    mocks.fetchMediaBytes.mockImplementation(async (url: string) =>
      url.endsWith("a.png") ? bytesByUrl(url) : null
    );
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    const ok = await finalizeGeneratedResult(input());

    expect(ok).toBe(true);
    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: ["u1/a.png"], resultText: undefined },
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
    expect(mocks.fetchMediaBytes).not.toHaveBeenCalled();
  });

  it("下载前发现已取消 → 不下载不写终态", async () => {
    mocks.getTaskStatus.mockResolvedValue("cancelled");

    const ok = await finalizeGeneratedResult(input());

    expect(ok).toBe(false);
    expect(mocks.fetchMediaBytes).not.toHaveBeenCalled();
    expect(mocks.safeCompleteTask).not.toHaveBeenCalled();
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("终态写入被守卫拒绝（返回 null）→ 返回 false 不抛错", async () => {
    mocks.safeCompleteTask.mockResolvedValue(null);

    const ok = await finalizeGeneratedResult(input({ urls: ["http://cdn.test/a.png"] }));

    expect(ok).toBe(false);
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });
});

describe("产物身份收口", () => {
  it("重复候选（同 URL 两次）→ 只取一次字节、结果一条", async () => {
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    await finalizeGeneratedResult(input({ urls: ["http://cdn.test/a.png", "http://cdn.test/a.png"] }));

    expect(mocks.fetchMediaBytes).toHaveBeenCalledTimes(1);
    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: ["u1/a.png"], resultText: undefined },
      { startedAt }
    );
  });

  it("同字节不同表示（url + data URL）→ 合并且只落盘一次", async () => {
    mocks.fetchMediaBytes.mockImplementation(async () => Buffer.from("image-a"));
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    await finalizeGeneratedResult(
      input({ urls: ["http://cdn.test/x", "data:image/png;base64,AAAA"] })
    );

    expect(mocks.fetchMediaBytes).toHaveBeenCalledTimes(2);
    expect(mocks.persistMediaBytes).toHaveBeenCalledTimes(1);
    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: ["u1/image-a"], resultText: undefined },
      { startedAt }
    );
  });

  it("同一 b64 出现两次（原串相同）→ 一条结果", async () => {
    mocks.fetchMediaBytes.mockImplementation(async () => Buffer.from("image-b"));
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    await finalizeGeneratedResult(
      input({ urls: ["data:image/png;base64,AAAA", "data:image/png;base64,AAAA"] })
    );

    expect(mocks.fetchMediaBytes).toHaveBeenCalledTimes(1);
    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: ["u1/image-b"], resultText: undefined },
      { startedAt }
    );
  });

  it("data URL 前缀 label 不同、载荷相同 → 按字节合并", async () => {
    mocks.fetchMediaBytes.mockImplementation(async () => Buffer.from("image-c"));
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    await finalizeGeneratedResult(
      input({ urls: ["data:image/png;base64,AAAA", "data:image/jpeg;base64,AAAA"] })
    );

    expect(mocks.persistMediaBytes).toHaveBeenCalledTimes(1);
    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: ["u1/image-c"], resultText: undefined },
      { startedAt }
    );
  });

  it("不同字节 → 各留一条，顺序为首现顺序", async () => {
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    await finalizeGeneratedResult(
      input({ urls: ["http://cdn.test/b.png", "http://cdn.test/a.png"] })
    );

    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: ["u1/b.png", "u1/a.png"], resultText: undefined },
      { startedAt }
    );
  });

  it("首次取字节失败不登记候选：同串重复候选会重试", async () => {
    mocks.fetchMediaBytes
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => Buffer.from("retry-ok"));
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    await finalizeGeneratedResult(input({ urls: ["http://cdn.test/a", "http://cdn.test/a"] }));

    expect(mocks.fetchMediaBytes).toHaveBeenCalledTimes(2);
    expect(mocks.persistMediaBytes).toHaveBeenCalledTimes(1);
    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: ["u1/retry-ok"], resultText: undefined },
      { startedAt }
    );
  });

  it("落盘失败不把身份记成已存在：同字节的后续候选可以补上", async () => {
    mocks.fetchMediaBytes.mockImplementation(async () => Buffer.from("same"));
    mocks.persistMediaBytes.mockRejectedValueOnce(new Error("db down"));
    mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });

    await finalizeGeneratedResult(input({ urls: ["http://cdn.test/1", "http://cdn.test/2"] }));

    expect(mocks.persistMediaBytes).toHaveBeenCalledTimes(2);
    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultUrls: ["u1/same"], resultText: undefined },
      { startedAt }
    );
  });
});

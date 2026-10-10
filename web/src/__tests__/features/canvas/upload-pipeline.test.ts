/**
 * 上传管道的失败处理与落库时机回归测试。
 *
 * 锁住两类曾出现过的退化：
 * 1. 上传失败后必须保留占位节点并写入 upload.error（用户才能在节点上重试）——
 *    即使上传过程中有过进度回调；此前结果统一在整批跑完后处理，导致
 *    「已开始上传」的节点丢失失败态，只剩「排队中」的节点有重试按钮。
 * 2. 单个任务结束即落库：先完成的文件不应等待同批最慢的那个，
 *    否则表现为「进度条走完却迟迟不出图」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { retryNodeUpload, runMediaUpload } from "@/features/canvas/upload";
import { useUploadProgressStore } from "@/features/canvas/upload/upload-progress-store";
import { changeSession } from "@/lib/session-lifecycle";
import { loadUploadLimits } from "@/lib/upload-formats";
import { uploadBatchWithRetry, type UploadErrorInfo, uploadWithRetry } from "@/lib/utils/upload";

// ── 隔离浏览器 / 副作用依赖：本测试只验证「管道 ↔ 画布状态」的交互 ──
vi.mock("@/lib/i18n/config", () => ({ default: { t: (k: string) => k, exists: () => true } }));
vi.mock("@/lib/global-message", () => ({ showGlobalMessage: () => ({ error: vi.fn() }) }));
vi.mock("@/lib/global-notification", () => ({ showGlobalNotification: () => ({ error: vi.fn() }) }));
vi.mock("@/lib/upload-formats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upload-formats")>();
  return { ...actual, loadUploadLimits: vi.fn() };
});
vi.mock("@/features/project/save-manager", () => ({
  saveManager: {
    markDirty: vi.fn(),
    markDirtyImmediate: vi.fn(),
    flushAndWait: vi.fn(),
  },
}));
// 只替换上传执行体，保留并发控制与其余真实实现
vi.mock("@/lib/utils/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/upload")>();
  return { ...actual, uploadBatchWithRetry: vi.fn(), uploadWithRetry: vi.fn() };
});

function fileOf(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

/** 显式给出自然尺寸：跳过本地尺寸探测（node 环境没有 document / Image） */
function item(name: string) {
  return { blob: fileOf(name), filename: name, naturalWidth: 800, naturalHeight: 600 };
}

function dataOf(nodeId: string) {
  const node = useCanvasStore.getState().getNodes().find((n) => n.id === nodeId);
  return node?.data as { upload?: { error?: UploadErrorInfo }; src?: string } | undefined;
}

describe("上传管道的失败与落库行为", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [] });
    useUploadProgressStore.getState().clearAll();
    vi.mocked(loadUploadLimits).mockReset();
    vi.mocked(loadUploadLimits).mockResolvedValue({
      maxSizeMb: 100,
      maxBatchFiles: 20,
      maxBatchBytes: 128 * 1024 * 1024,
      formats: { image: ["png"], video: [], audio: [] },
    });
    vi.mocked(uploadBatchWithRetry).mockReset();
    vi.mocked(uploadWithRetry).mockReset();
  });

  it("上传途中失败：保留占位节点并写入可重试的失败态", async () => {
    vi.mocked(uploadBatchWithRetry).mockResolvedValue([
      { status: "rejected", reason: new Error("network down") },
    ]);

    const { nodeIds, settled } = await runMediaUpload({
      items: [item("a.png")],
      sink: { kind: "create-node" },
    });
    const summary = await settled;

    expect(summary.failed).toBe(1);
    const data = dataOf(nodeIds[0]);
    expect(data).toBeTruthy();
    expect(data?.upload?.error).toBeTruthy();
    expect(data?.upload?.error?.retryable).toBe(true);
    expect(useUploadProgressStore.getState().byNodeId.size).toBe(0);
  });

  it("多文件按批次响应分别落库", async () => {
    vi.mocked(uploadBatchWithRetry).mockResolvedValue([
      { status: "fulfilled", value: { url: "https://cdn/slow.png", key: "slow.png" } },
      { status: "fulfilled", value: { url: "https://cdn/fast.png", key: "fast.png" } },
    ]);

    const { nodeIds, settled } = await runMediaUpload({
      items: [item("slow.png"), item("fast.png")],
      sink: { kind: "create-node" },
    });

    const summary = await settled;
    expect(summary.succeeded).toBe(2);
    expect(dataOf(nodeIds[0])?.src).toBe("https://cdn/slow.png");
  });

  it("会话结束后不写回旧上传结果或开始队列里的文件", async () => {
    let finish!: (value: Array<PromiseSettledResult<{ url: string; key: string }>>) => void;
    vi.mocked(uploadBatchWithRetry).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { nodeIds, settled } = await runMediaUpload({
      items: [item("first.png"), item("queued.png")], sink: { kind: "create-node" },
    });
    await vi.waitFor(() => expect(vi.mocked(uploadBatchWithRetry)).toHaveBeenCalledTimes(1));
    changeSession();
    finish([
      { status: "fulfilled", value: { url: "https://cdn/a.png", key: "a" } },
      { status: "fulfilled", value: { url: "https://cdn/b.png", key: "b" } },
    ]);
    const result = await settled;
    expect(result).toMatchObject({ succeeded: 0, failed: 2, results: [null, null] });
    expect(vi.mocked(uploadBatchWithRetry)).toHaveBeenCalledTimes(1);
    for (const id of nodeIds) expect(dataOf(id)?.src).toBeFalsy();
  });

  it("会话结束后释放失败文件的重试上下文", async () => {
    vi.mocked(uploadBatchWithRetry).mockResolvedValue([
      { status: "rejected", reason: new Error("network down") },
    ]);
    const { nodeIds, settled } = await runMediaUpload({ items: [item("a.png")], sink: { kind: "create-node" } });
    await settled;
    changeSession();
    vi.mocked(uploadWithRetry).mockClear();
    expect(await retryNodeUpload(nodeIds[0])).toBe(false);
    expect(vi.mocked(uploadWithRetry)).not.toHaveBeenCalled();
  });

  it("create-node 多文件使用批次上传契约", async () => {
    vi.mocked(uploadBatchWithRetry).mockResolvedValue([
      { status: "fulfilled", value: { url: "https://cdn/a.png", key: "a.png" } },
      { status: "fulfilled", value: { url: "https://cdn/b.png", key: "b.png" } },
    ]);

    const { settled } = await runMediaUpload({
      items: [item("a.png"), item("b.png")],
      sink: { kind: "create-node" },
    });
    await settled;

    expect(vi.mocked(uploadBatchWithRetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadBatchWithRetry).mock.calls[0][0]).toHaveLength(2);
    expect(vi.mocked(uploadWithRetry)).not.toHaveBeenCalled();
  });

  it("200 个文件按服务端批次限制拆分并全部完成", async () => {
    vi.mocked(uploadBatchWithRetry).mockImplementation(async (files) => files.map((file) => ({
      status: "fulfilled",
      value: { url: `https://cdn/${file.name}`, key: file.name },
    })));

    const { settled } = await runMediaUpload({
      items: Array.from({ length: 200 }, (_, index) => item(`${index}.png`)),
      sink: { kind: "raw" },
    });
    const summary = await settled;

    expect(summary).toMatchObject({ succeeded: 200, failed: 0 });
    expect(vi.mocked(uploadBatchWithRetry)).toHaveBeenCalledTimes(10);
    expect(vi.mocked(uploadBatchWithRetry).mock.calls.every(([files]) => files.length <= 20)).toBe(true);
  });

  it("单批总字节超限时按字节数边界拆批（不只按文件数）", async () => {
    vi.mocked(loadUploadLimits).mockResolvedValue({
      maxSizeMb: 100,
      maxBatchFiles: 20,
      maxBatchBytes: 6,
      formats: { image: ["png"], video: [], audio: [] },
    });
    vi.mocked(uploadBatchWithRetry).mockImplementation(async (files) => files.map((file) => ({
      status: "fulfilled",
      value: { url: `https://cdn/${file.name}`, key: file.name },
    })));

    // 6 个 3 字节文件：字节上限 6 → 每批 2 个 → 3 批（文件数上限 20 从不触发）
    const { settled } = await runMediaUpload({
      items: Array.from({ length: 6 }, (_, index) => item(`${index}.png`)),
      sink: { kind: "raw" },
    });
    const summary = await settled;

    expect(summary).toMatchObject({ succeeded: 6, failed: 0 });
    expect(vi.mocked(uploadBatchWithRetry)).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(uploadBatchWithRetry).mock.calls.map(([files]) => files.length),
    ).toEqual([2, 2, 2]);
  });

  it("限制请求期间会话结束：不发送旧会话的 raw 批次", async () => {
    let resolveLimits!: (limits: {
      maxSizeMb: number;
      maxBatchFiles: number;
      maxBatchBytes: number;
      formats: { image: string[]; video: string[]; audio: string[] };
    }) => void;
    const limits = new Promise<{
      maxSizeMb: number;
      maxBatchFiles: number;
      maxBatchBytes: number;
      formats: { image: string[]; video: string[]; audio: string[] };
    }>((resolve) => { resolveLimits = resolve; });
    vi.mocked(loadUploadLimits).mockReturnValue(limits);
    vi.mocked(uploadBatchWithRetry).mockResolvedValue([{
      status: "fulfilled",
      value: { url: "https://cdn/raw.png", key: "raw.png" },
    }]);

    const { settled } = await runMediaUpload({ items: [item("raw.png")], sink: { kind: "raw" } });
    changeSession();
    resolveLimits({
      maxSizeMb: 100,
      maxBatchFiles: 20,
      maxBatchBytes: 128 * 1024 * 1024,
      formats: { image: ["png"], video: [], audio: [] },
    });

    const summary = await settled;
    expect(summary).toMatchObject({ succeeded: 0, failed: 1, results: [null] });
    expect(vi.mocked(uploadBatchWithRetry)).not.toHaveBeenCalled();
  });

  it("单文件超过批次总大小时按业务失败落库，不发注定 413 的请求", async () => {
    vi.mocked(loadUploadLimits).mockResolvedValue({
      maxSizeMb: 100,
      maxBatchFiles: 20,
      maxBatchBytes: 2,
      formats: { image: ["png"], video: [], audio: [] },
    });
    vi.mocked(uploadBatchWithRetry).mockResolvedValue([]);

    const { nodeIds, settled } = await runMediaUpload({
      items: [item("big.png")],
      sink: { kind: "create-node" },
    });
    const summary = await settled;

    expect(summary.failed).toBe(1);
    expect(vi.mocked(uploadBatchWithRetry)).not.toHaveBeenCalled();
    const data = dataOf(nodeIds[0]);
    expect(data?.upload?.error).toBeTruthy();
    expect(data?.upload?.error?.retryable).toBe(false);
  });

  it("批次字节进度按体积归因到各文件", async () => {
    let captured: ((pct: number, loaded: number) => void) | undefined;
    vi.mocked(uploadBatchWithRetry).mockImplementation(async (_files, onProgress) => {
      captured = onProgress;
      return [
        { status: "fulfilled", value: { url: "https://cdn/small.png", key: "small.png" } },
        { status: "fulfilled", value: { url: "https://cdn/large.png", key: "large.png" } },
      ];
    });
    const onProgress = vi.fn();
    const { settled } = await runMediaUpload({
      items: [
        { blob: new File([new Uint8Array(1)], "small.png", { type: "image/png" }), filename: "small.png" },
        { blob: new File([new Uint8Array(3)], "large.png", { type: "image/png" }), filename: "large.png" },
      ],
      sink: { kind: "raw" },
      onProgress,
    });
    await settled;

    // 批次 4 字节：小文件 [0,1)，大文件 [1,4)。loaded=2 时小文件已完成，大文件 1/3
    captured?.(50, 2);
    expect(onProgress).toHaveBeenCalledWith(0, 100);
    expect(onProgress).toHaveBeenCalledWith(1, 33);
    // 重试前的重置回调：loaded=0，所有文件进度归零
    captured?.(0, 0);
    expect(onProgress).toHaveBeenLastCalledWith(1, 0);
  });

  it("断网后未开始的批次不发送，剩余文件都结算为失败而非一直排队", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(loadUploadLimits).mockResolvedValue({
      maxSizeMb: 100, maxBatchFiles: 1, maxBatchBytes: 128 * 1024 * 1024,
      formats: { image: ["png"], video: [], audio: [] },
    });
    vi.mocked(uploadBatchWithRetry).mockImplementation(async () => {
      vi.stubGlobal("navigator", { onLine: false });
      return [{ status: "fulfilled", value: { key: "first", url: "first" } }];
    });
    const { nodeIds, settled } = await runMediaUpload({
      items: [item("first.png"), item("second.png"), item("third.png")],
      sink: { kind: "create-node" },
    });
    const summary = await settled;
    expect(uploadBatchWithRetry).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ succeeded: 1, failed: 2 });
    expect(summary.errors[1]?.message).toBe("error.upload.offline");
    expect(summary.errors[2]?.message).toBe("error.upload.offline");
    expect(dataOf(nodeIds[1])?.upload?.error).toBeTruthy();
    expect(dataOf(nodeIds[2])?.upload?.error).toBeTruthy();
    expect(useUploadProgressStore.getState().byNodeId.size).toBe(0);
  });

  it("raw sink 的逐项失败原因按原索引保留，成功项不受影响", async () => {
    vi.mocked(uploadBatchWithRetry).mockResolvedValue([
      { status: "fulfilled", value: { key: "ok", url: "ok" } },
      { status: "rejected", reason: new Error("size limit exceeded") },
      { status: "rejected", reason: new Error("unsupported media") },
    ]);
    const { settled } = await runMediaUpload({
      items: [item("ok.png"), item("big.png"), item("bad.png")], sink: { kind: "raw" }, silent: true,
    });
    const summary = await settled;
    expect(summary.errors).toHaveLength(3);
    expect(summary.errors[0]).toBeUndefined();
    expect(summary.errors[1]?.message).toBe("size limit exceeded");
    expect(summary.errors[2]?.message).toBe("unsupported media");
  });

  it("多文件部分失败：失败项留在画布上，成功项正常落库", async () => {
    vi.mocked(uploadBatchWithRetry).mockResolvedValue([
      { status: "rejected", reason: new Error("offline") },
      { status: "fulfilled", value: { url: "https://cdn/good.png", key: "good.png" } },
    ]);

    const { nodeIds, settled } = await runMediaUpload({
      items: [item("bad.png"), item("good.png")],
      sink: { kind: "create-node" },
    });
    const summary = await settled;

    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(dataOf(nodeIds[0])?.upload?.error).toBeTruthy();
    expect(dataOf(nodeIds[1])?.src).toBe("https://cdn/good.png");
    expect(useUploadProgressStore.getState().byNodeId.size).toBe(0);
  });
});

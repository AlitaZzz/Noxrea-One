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

import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { runMediaUpload } from "@/features/canvas/upload";
import { type UploadErrorInfo, uploadWithRetry } from "@/lib/utils/upload";

// ── 隔离浏览器 / 副作用依赖：本测试只验证「管道 ↔ 画布状态」的交互 ──
vi.mock("@/lib/i18n/config", () => ({ default: { t: (k: string) => k } }));
vi.mock("@/lib/global-message", () => ({ showGlobalMessage: () => ({ error: vi.fn() }) }));
vi.mock("@/lib/global-notification", () => ({ showGlobalNotification: () => ({ error: vi.fn() }) }));
vi.mock("@/features/project/save-manager", () => ({
  saveManager: {
    markDirty: vi.fn(),
    markDirtyImmediate: vi.fn(),
    flushSave: vi.fn(),
    flushAndWait: vi.fn(),
    status: { dirty: false, saving: false },
  },
}));
// 只替换上传执行体，保留并发控制与其余真实实现
vi.mock("@/lib/utils/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/upload")>();
  return { ...actual, uploadWithRetry: vi.fn() };
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
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [] });
    vi.mocked(uploadWithRetry).mockReset();
  });

  it("上传途中失败：保留占位节点并写入可重试的失败态", async () => {
    vi.mocked(uploadWithRetry).mockImplementation(async (_file, onProgress) => {
      onProgress?.(50); // 有过进度推进：该路径曾因批量处理而丢失失败态
      throw new Error("network down");
    });

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
  });

  it("多文件并发：先完成的立即落库，不等待整批结束", async () => {
    vi.mocked(uploadWithRetry).mockImplementation(async (file) => {
      await new Promise((r) => setTimeout(r, file.name === "slow.png" ? 60 : 5));
      return { url: `https://cdn/${file.name}`, key: file.name };
    });

    const { nodeIds, settled } = await runMediaUpload({
      items: [item("slow.png"), item("fast.png")],
      sink: { kind: "create-node" },
      concurrency: 2,
    });

    // 快文件应在慢文件尚未返回时就已落库
    await vi.waitFor(() => {
      expect(dataOf(nodeIds[1])?.src).toBe("https://cdn/fast.png");
    });
    expect(dataOf(nodeIds[0])?.src).toBeFalsy();

    const summary = await settled;
    expect(summary.succeeded).toBe(2);
    expect(dataOf(nodeIds[0])?.src).toBe("https://cdn/slow.png");
  });

  it("多文件部分失败：失败项留在画布上，成功项正常落库", async () => {
    vi.mocked(uploadWithRetry).mockImplementation(async (file) => {
      if (file.name === "bad.png") throw new Error("offline");
      return { url: `https://cdn/${file.name}`, key: file.name };
    });

    const { nodeIds, settled } = await runMediaUpload({
      items: [item("bad.png"), item("good.png")],
      sink: { kind: "create-node" },
      concurrency: 2,
    });
    const summary = await settled;

    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(dataOf(nodeIds[0])?.upload?.error).toBeTruthy();
    expect(dataOf(nodeIds[1])?.src).toBe("https://cdn/good.png");
  });
});

/**
 * replace-node 上传的撤销语义测试（Spec: canvas-undo-redo-integrity 规则 7）。
 *
 * 上传/更换节点内容是离散用户操作，必须有独立撤销步：
 * - 压栈时机在上传瞬态写入「之前」（此刻节点仍是替换前内容，未被瞬态污染）；
 * - 瞬态写入与成功回填全部 skipHistory（僵尸进度条态永不入栈）；
 * - 失败回滚后按引用弹出补偿快照（回滚已还原替换前内容，快照成冗余步）。
 *
 * canvas-store / history-store 走真实实现，仅 mock 网络与提示层。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadBatchWithRetry: vi.fn(),
  loadUploadLimits: vi.fn(),
  kindOfBlob: vi.fn(() => "image"),
  isOffline: vi.fn(() => false),
  classifyUploadError: vi.fn(() => ({ kind: "network" as const, message: "boom" })),
}));

vi.mock("@/lib/api/client", () => ({
  apiUploadWithProgress: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
  BASE: "http://test",
  getTokenHeader: () => ({ Authorization: "Bearer test-token" }),
}));

vi.mock("@/lib/utils/upload", () => ({
  isOffline: mocks.isOffline,
  uploadBatchWithRetry: mocks.uploadBatchWithRetry,
  uploadWithRetry: vi.fn(),
  classifyUploadError: mocks.classifyUploadError,
  UPLOAD_MAX_RETRIES: 2,
  UploadBusinessError: class UploadBusinessError extends Error {},
}));

vi.mock("@/lib/upload-formats", () => ({
  FALLBACK_UPLOAD_LIMITS: { maxSizeMb: 100, maxBatchBytes: 128 * 1024 * 1024, maxBatchFiles: 20, maxFiles: 100 },
  kindOfBlob: mocks.kindOfBlob,
  loadUploadLimits: mocks.loadUploadLimits,
}));

// 只替换会话捕获（上传流程不需要真实会话中止语义），其余导出保持真实实现，
// 避免解析层等下游新增依赖时整模块替身缺项
vi.mock("@/lib/session-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session-lifecycle")>()),
  captureSession: () => ({ signal: new AbortController().signal }),
}));

vi.mock("@/lib/global-message", () => ({
  showGlobalMessage: () => ({ error: vi.fn(), warning: vi.fn(), success: vi.fn() }),
}));

import { undoAction } from "@/features/canvas/shared/canvas-edit-actions";
import { takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { AnyNode } from "@/features/canvas/types";
import { runMediaUpload } from "@/features/canvas/upload/upload-pipeline";
import { useUploadProgressStore } from "@/features/canvas/upload/upload-progress-store";
import { NODE_TYPE } from "@/lib/constants";

function makeImageNode(id: string, src?: string): AnyNode {
  return {
    id,
    type: NODE_TYPE.IMAGE,
    position: { x: 0, y: 0 },
    data: src ? { label: id, src, naturalWidth: 100, naturalHeight: 80 } : { label: id },
    style: { width: 300, height: 240 },
  } as unknown as AnyNode;
}

function nodeOf(id: string): AnyNode | undefined {
  return useCanvasStore.getState().nodes.find((n) => n.id === id);
}

function srcOf(id: string): string | undefined {
  return (nodeOf(id)?.data as { src?: string } | undefined)?.src;
}

async function replaceUpload(nodeId: string) {
  // 先 await 拿到 handle 再取 settled：直接在 Promise 上取 .settled 是 undefined
  const handle = await runMediaUpload({
    items: [{
      blob: new Blob(["x"], { type: "image/png" }),
      filename: "new.png",
      // 直接给 previewUrl：绕开 jsdom 缺失的 URL.createObjectURL
      previewUrl: "blob:mock-preview",
      naturalWidth: 120,
      naturalHeight: 90,
    }],
    sink: { kind: "replace-node", nodeId },
  });
  return handle.settled;
}

const NEW_KEY = `1/ab/${"c".repeat(64)}.png`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isOffline.mockReturnValue(false);
  mocks.kindOfBlob.mockReturnValue("image");
  mocks.classifyUploadError.mockReturnValue({ kind: "network", message: "boom" });
  mocks.loadUploadLimits.mockResolvedValue({ maxSizeMb: 100, maxBatchBytes: 128 * 1024 * 1024, maxBatchFiles: 20, maxFiles: 100 });
  mocks.uploadBatchWithRetry.mockResolvedValue([
    { status: "fulfilled", value: { url: `http://test/api/files/${NEW_KEY}`, key: NEW_KEY, width: 120, height: 90 } },
  ]);
  useHistoryStore.getState().clear();
  useUploadProgressStore.getState().clearAll();
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replace 上传的撤销语义", () => {
  it("有内容节点更换图片：撤销一次回到替换前内容，节点保留", async () => {
    useCanvasStore.setState({ nodes: [makeImageNode("n1", "http://old.png")], edges: [] });
    const depth = useHistoryStore.getState().undoStack.length;

    await replaceUpload("n1");

    // 仅压一条（上传开始时的替换前快照），瞬态与回填均不压栈
    expect(useHistoryStore.getState().undoStack.length).toBe(depth + 1);
    // 落库值域：节点 src 写存储 key（url 仅为访问派生）
    expect(srcOf("n1")).toBe(NEW_KEY);
    expect((nodeOf("n1")!.data as { upload?: unknown }).upload).toBeUndefined();

    expect(undoAction()).toBe(true);
    expect(nodeOf("n1")).toBeDefined();
    expect(srcOf("n1")).toBe("http://old.png");
    expect((nodeOf("n1")!.data as { upload?: unknown }).upload).toBeUndefined();
  });

  it("空节点上传：撤销回到空节点（而非删除节点），再撤销才回到创建前", async () => {
    // 创建前（画布为空）压一条，再让空节点出现并压一条
    useCanvasStore.setState({ nodes: [] });
    useHistoryStore.getState().push(takeCanvasSnapshot());
    useCanvasStore.setState({ nodes: [makeImageNode("n1")] });
    useHistoryStore.getState().push(takeCanvasSnapshot());

    await replaceUpload("n1");
    expect(srcOf("n1")).toBe(NEW_KEY);

    // 第一次撤销：撤销上传，空节点保留
    expect(undoAction()).toBe(true);
    expect(nodeOf("n1")).toBeDefined();
    expect(srcOf("n1")).toBeUndefined();
    expect((nodeOf("n1")!.data as { upload?: unknown }).upload).toBeUndefined();

    // 第二次撤销：回到「空节点已存在」的快照（内容与上传前一致，节点仍在）
    expect(undoAction()).toBe(true);
    expect(nodeOf("n1")).toBeDefined();

    // 第三次撤销：回到创建前，节点消失
    expect(undoAction()).toBe(true);
    expect(nodeOf("n1")).toBeUndefined();
  });

  it("replace 失败回滚后弹出补偿快照：撤销栈不留冗余步", async () => {
    useCanvasStore.setState({ nodes: [makeImageNode("n1", "http://old.png")], edges: [] });
    const depth = useHistoryStore.getState().undoStack.length;
    // 上传契约是全 settled：失败以 rejected 结果表达，不 reject 整批
    mocks.uploadBatchWithRetry.mockResolvedValue([
      { status: "rejected", reason: new Error("network gone") },
    ]);

    await replaceUpload("n1");

    // 回滚生效 + 压栈被弹出，栈深复原
    expect(srcOf("n1")).toBe("http://old.png");
    expect((nodeOf("n1")!.data as { upload?: unknown }).upload).toBeUndefined();
    expect(useHistoryStore.getState().undoStack.length).toBe(depth);
  });
});

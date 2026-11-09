/**
 * 资产原始上传（Blob → 远程引用）的结算契约：
 * 逐项结果与入参下标对齐、请求前的失败不发请求、进度按下标归位、uploadOne 的提示开关。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadBatchWithRetry: vi.fn(),
  loadUploadLimits: vi.fn(),
  messageError: vi.fn(),
}));

vi.mock("@/lib/utils/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/upload")>();
  return { ...actual, uploadBatchWithRetry: mocks.uploadBatchWithRetry };
});
vi.mock("@/lib/upload-formats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upload-formats")>();
  return { ...actual, loadUploadLimits: mocks.loadUploadLimits };
});
vi.mock("@/lib/global-message", () => ({
  showGlobalMessage: () => ({ error: mocks.messageError }),
}));
vi.mock("@/lib/i18n/config", () => ({
  default: { exists: () => false, t: (key: string) => key },
}));

import { uploadMany, uploadOne } from "@/entities/asset";
import { changeSession } from "@/lib/session-lifecycle";
import type { UploadLimits } from "@/lib/upload-formats";

const LIMITS: UploadLimits = {
  maxSizeMb: 100,
  maxBatchFiles: 20,
  maxBatchBytes: 128 * 1024 * 1024,
  formats: { image: ["png"], video: [], audio: [] },
  mode: "relay",
};

function png(name: string, bytes = 1): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function fulfilledFor(files: File[]) {
  return files.map((file) => ({
    status: "fulfilled" as const,
    value: { url: `https://cdn/${file.name}`, key: file.name },
  }));
}

beforeEach(() => {
  vi.mocked(mocks.uploadBatchWithRetry).mockReset();
  vi.mocked(mocks.loadUploadLimits).mockReset().mockResolvedValue(LIMITS);
  mocks.messageError.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadMany 逐项结算", () => {
  it("不支持的类型直接失败，不发请求，结果与入参顺序对齐", async () => {
    vi.mocked(mocks.uploadBatchWithRetry).mockImplementation(async (files) => fulfilledFor(files));

    const summary = await uploadMany([
      { blob: new Blob([new Uint8Array(1)], { type: "application/pdf" }), filename: "doc.pdf" },
      { blob: png("ok.png"), filename: "ok.png" },
    ]);

    expect(mocks.uploadBatchWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.uploadBatchWithRetry.mock.calls[0][0].map((file: File) => file.name)).toEqual(["ok.png"]);
    expect(summary.outcomes).toHaveLength(2);
    expect(summary.outcomes[0]).toEqual({
      result: null,
      error: expect.objectContaining({ category: "unsupported", retryable: false }),
    });
    expect(summary.outcomes[1]).toEqual({ result: { url: "https://cdn/ok.png", key: "ok.png" }, error: null });
  });

  it("离线时全部返回 offline，且不发请求", async () => {
    vi.stubGlobal("navigator", { onLine: false });

    const summary = await uploadMany([
      { blob: png("a.png"), filename: "a.png" },
      { blob: png("b.png"), filename: "b.png" },
    ]);

    expect(mocks.uploadBatchWithRetry).not.toHaveBeenCalled();
    expect(summary.outcomes).toEqual([
      { result: null, error: expect.objectContaining({ category: "offline", retryable: false }) },
      { result: null, error: expect.objectContaining({ category: "offline", retryable: false }) },
    ]);
  });

  it("单文件超过体积上限但仍在批次字节上限内时，不发请求并按业务失败结算", async () => {
    vi.mocked(mocks.loadUploadLimits).mockResolvedValue({
      ...LIMITS,
      maxSizeMb: 1,
      maxBatchBytes: 2 * 1024 * 1024,
    });
    vi.mocked(mocks.uploadBatchWithRetry).mockImplementation(async (files) => fulfilledFor(files));

    const summary = await uploadMany([
      { blob: png("ok.png", 1), filename: "ok.png" },
      { blob: png("too-big.png", 1024 * 1024 + 1), filename: "too-big.png" },
    ]);

    expect(mocks.uploadBatchWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.uploadBatchWithRetry.mock.calls[0][0].map((file: File) => file.name)).toEqual(["ok.png"]);
    expect(summary.outcomes[0]?.result?.key).toBe("ok.png");
    expect(summary.outcomes[1]).toEqual({
      result: null,
      error: expect.objectContaining({ category: "business", retryable: false }),
    });
  });

  it("单文件超过批次字节上限时按业务失败返回，不发送注定被拒的请求", async () => {
    vi.mocked(mocks.loadUploadLimits).mockResolvedValue({ ...LIMITS, maxBatchBytes: 2 });
    vi.mocked(mocks.uploadBatchWithRetry).mockImplementation(async (files) => fulfilledFor(files));

    const summary = await uploadMany([
      { blob: png("small.png", 1), filename: "small.png" },
      { blob: png("big.png", 3), filename: "big.png" },
    ]);

    expect(mocks.uploadBatchWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.uploadBatchWithRetry.mock.calls[0][0].map((file: File) => file.name)).toEqual(["small.png"]);
    expect(summary.outcomes[0]?.result?.key).toBe("small.png");
    expect(summary.outcomes[1]).toEqual({
      result: null,
      error: expect.objectContaining({ category: "business", retryable: false }),
    });
  });

  it("会话在限制加载期间结束：不发请求，剩余项按中止结算", async () => {
    let resolveLimits!: (limits: UploadLimits) => void;
    vi.mocked(mocks.loadUploadLimits).mockReturnValue(new Promise<UploadLimits>((resolve) => {
      resolveLimits = resolve;
    }));

    const pending = uploadMany([{ blob: png("a.png"), filename: "a.png" }]);
    changeSession();
    resolveLimits(LIMITS);
    const summary = await pending;

    expect(mocks.uploadBatchWithRetry).not.toHaveBeenCalled();
    expect(summary.outcomes[0]).toEqual({
      result: null,
      error: expect.objectContaining({ category: "abort", retryable: false }),
    });
  });

  it("按批次上传并把进度与结果归位到原始下标", async () => {
    vi.mocked(mocks.loadUploadLimits).mockResolvedValue({ ...LIMITS, maxBatchFiles: 2 });
    vi.mocked(mocks.uploadBatchWithRetry).mockImplementation(async (files, onProgress) => {
      onProgress?.(0, { phase: "uploading", pct: 50 });
      onProgress?.(files.length - 1, { phase: "uploading", pct: 100 });
      return fulfilledFor(files);
    });
    const progress: Array<[number, number]> = [];

    const items = ["0.png", "1.png", "2.png", "3.png", "4.png"].map((name) => ({ blob: png(name), filename: name }));
    const summary = await uploadMany(items, {
      source: "upload",
      onProgress: (index, value) => {
        if (value.phase === "uploading") progress.push([index, value.pct]);
      },
    });

    expect(mocks.uploadBatchWithRetry.mock.calls.map(([files]) => (files as File[]).length)).toEqual([2, 2, 1]);
    expect(summary.outcomes.map((outcome) => outcome.result?.key)).toEqual([
      "0.png", "1.png", "2.png", "3.png", "4.png",
    ]);
    // 第二批的批内 0 对应原始下标 2；末批只有一项，首尾两次进度都是下标 4
    expect(progress).toEqual([[0, 50], [1, 100], [2, 50], [3, 100], [4, 50], [4, 100]]);
    for (const [, , , source] of mocks.uploadBatchWithRetry.mock.calls) {
      expect(source).toBe("upload");
    }
  });
});

describe("uploadOne", () => {
  it("失败默认静默，notify 为 true 时经全局消息提示一次", async () => {
    const blob = new Blob([new Uint8Array(1)], { type: "application/pdf" });

    expect(await uploadOne(blob, "doc.pdf")).toBeNull();
    expect(mocks.messageError).not.toHaveBeenCalled();

    expect(await uploadOne(blob, "doc.pdf", undefined, { notify: true })).toBeNull();
    expect(mocks.messageError).toHaveBeenCalledTimes(1);
  });

  it("成功时返回上传结果", async () => {
    vi.mocked(mocks.uploadBatchWithRetry).mockImplementation(async (files) => fulfilledFor(files));

    await expect(uploadOne(png("ok.png"), "ok.png")).resolves.toEqual({
      url: "https://cdn/ok.png",
      key: "ok.png",
    });
    expect(mocks.messageError).not.toHaveBeenCalled();
  });
});

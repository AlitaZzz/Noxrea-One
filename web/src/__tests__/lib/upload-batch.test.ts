import { afterEach, describe, expect, it, vi } from "vitest";

const uploadBatch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", async (original) => ({
  ...await original<typeof import("@/lib/api/client")>(),
  apiUploadWithProgress: uploadBatch,
}));
vi.mock("@/lib/i18n/config", () => ({ default: { t: (key: string) => key, exists: () => true } }));
vi.mock("@/lib/api/error-message", () => ({ resolveApiError: () => "item failed" }));

import { UploadTransportError } from "@/lib/api/client";
import { uploadBatchWithRetry } from "@/lib/utils/upload";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("uploadBatchWithRetry", () => {
  it("按文件索引映射逐项结果，并以一个 FormData 提交批次", async () => {
    uploadBatch.mockResolvedValue({
      items: [
        { index: 0, ok: true, data: { url: "a", key: "a" } },
        { index: 1, ok: false, error: { code: "upload.file_too_large", ctx: { limit: 30 } } },
      ],
    });
    const files = [new File(["a"], "a.png", { type: "image/png" }), new File(["b"], "b.png", { type: "image/png" })];

    const results = await uploadBatchWithRetry(files);
    const form = uploadBatch.mock.calls[0][1] as FormData;

    expect(form.getAll("file")).toHaveLength(2);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { url: "a" } });
    expect(results[1].status).toBe("rejected");
    if (results[1].status === "rejected") expect(results[1].reason.message).toBe("item failed");
  });

  it("429 按 Retry-After 等待后重试整个批次", async () => {
    vi.useFakeTimers();
    uploadBatch
      .mockRejectedValueOnce(new UploadTransportError("http", "rate limited", 429, 1000))
      .mockResolvedValueOnce({ items: [{ index: 0, ok: true, data: { url: "a", key: "a" } }] });

    const pending = uploadBatchWithRetry([new File(["a"], "a.png", { type: "image/png" })]);
    await vi.advanceTimersByTimeAsync(999);
    expect(uploadBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject([{ status: "fulfilled" }]);
    expect(uploadBatch).toHaveBeenCalledTimes(2);
  });

  it("重复内容文件按索引独立映射，互不覆盖", async () => {
    uploadBatch.mockResolvedValue({
      items: [
        { index: 0, ok: true, data: { url: "same", key: "same" } },
        { index: 1, ok: true, data: { url: "same", key: "same" } },
      ],
    });
    const content = ["same"];
    const results = await uploadBatchWithRetry([
      new File(content, "a.png", { type: "image/png" }),
      new File(content, "b.png", { type: "image/png" }),
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { url: "same", key: "same" } });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { url: "same", key: "same" } });
  });

  it("离线时不创建请求，不调用传输层", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const results = await uploadBatchWithRetry([new File(["a"], "a.png", { type: "image/png" })]);
    expect(uploadBatch).not.toHaveBeenCalled();
    expect(results[0].status).toBe("rejected");
    if (results[0].status === "rejected") expect(results[0].reason.message).toBe("error.upload.offline");
  });

  it("批次成功项缺少 URL 时按业务失败处理", async () => {
    uploadBatch.mockResolvedValue({ items: [{ index: 0, ok: true, data: { key: "a" } }] });

    const [result] = await uploadBatchWithRetry([new File(["a"], "a.png", { type: "image/png" })]);

    expect(result.status).toBe("rejected");
  });
});

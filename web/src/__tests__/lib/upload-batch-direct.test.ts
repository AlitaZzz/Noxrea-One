/**
 * 直传批次（direct 模式）单测：模式分派、秒传短路、业务失败不重试、
 * 429 退避重试、direct_unavailable 清缓存、进度按阶段逐文件归因、source 透传。
 */
import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  put: vi.fn(),
  relayBatch: vi.fn(),
  getUploadMode: vi.fn(),
  invalidateUploadLimits: vi.fn(),
}));

vi.mock("@/lib/api/client", async (original) => ({
  ...await original<typeof import("@/lib/api/client")>(),
  api: (...args: unknown[]) => mocks.api(...args),
  apiPresignedPutWithProgress: (...args: unknown[]) => mocks.put(...args),
  apiUploadWithProgress: (...args: unknown[]) => mocks.relayBatch(...args),
}));
vi.mock("@/lib/upload-formats", () => ({
  getUploadMode: mocks.getUploadMode,
  invalidateUploadLimits: mocks.invalidateUploadLimits,
}));
vi.mock("@/lib/i18n/config", () => ({ default: { t: (key: string) => key, exists: () => true } }));
vi.mock("@/lib/api/error-message", () => ({ resolveApiError: () => "item failed" }));

import { ApiError, UploadTransportError } from "@/lib/api/client";
import { uploadBatchWithRetry } from "@/lib/utils/upload";

const FILE = new File(["hello"], "a.png", { type: "image/png" });
const HASH = createHash("sha256").update("hello").digest("hex");
const TICKET = {
  duplicate: false,
  staging_key: "staging/3/11111111-2222-3333-4444-555555555555",
  upload_url: "https://s3.example/put",
  content_type: "image/png",
};
const COMPLETE = { file: { url: "https://s3.example/file", key: "3/ab/x.png", width: 10, height: 20 } };

const apiError = (status: number, error?: string) =>
  new ApiError(status, "failed", error ? { error, ctx: {} } : null);

/** api 桩按路径分派：ticket / complete 各自可配 */
function stubApi(ticket: () => Promise<unknown>, complete: () => Promise<unknown>): void {
  mocks.api.mockImplementation((path: string) => {
    if (path === "/api/files/upload-ticket") return ticket();
    if (path === "/api/files/upload-complete") return complete();
    throw new Error(`unexpected api path: ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUploadMode.mockReturnValue("direct");
  mocks.put.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("直传批次 uploadBatchWithRetry(direct)", () => {
  it("完整直传链：ticket → PUT 预签名 → complete，hash 与 source 进请求体", async () => {
    stubApi(() => Promise.resolve(TICKET), () => Promise.resolve(COMPLETE));

    const [result] = await uploadBatchWithRetry([FILE], undefined, 1, "derived");

    expect(result.status).toBe("fulfilled");
    if (result.status === "fulfilled") {
      expect(result.value).toMatchObject({ url: COMPLETE.file.url, key: COMPLETE.file.key, width: 10, height: 20 });
    }
    expect(mocks.put).toHaveBeenCalledWith(TICKET.upload_url, expect.any(File), "image/png", expect.any(Function), expect.anything());

    const ticketBody = JSON.parse(mocks.api.mock.calls[0][1].body as string);
    expect(ticketBody).toMatchObject({ hash: HASH, size: 5, name: "a.png", content_type: "image/png" });
    const completeBody = JSON.parse(mocks.api.mock.calls[1][1].body as string);
    expect(completeBody).toMatchObject({ staging_key: TICKET.staging_key, hash: HASH, source: "derived" });
  });

  it("秒传命中：不 PUT 不 complete，直接返回既有对象", async () => {
    stubApi(
      () => Promise.resolve({ duplicate: true, file: { url: "dup-url", key: "dup-key", width: null, height: null } }),
      () => Promise.reject(new Error("should not complete")),
    );

    const [result] = await uploadBatchWithRetry([FILE]);

    expect(result.status).toBe("fulfilled");
    if (result.status === "fulfilled") expect(result.value).toMatchObject({ url: "dup-url", key: "dup-key" });
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it("relay 模式：走 multipart 中转，不发直传请求", async () => {
    mocks.getUploadMode.mockReturnValue("relay");
    mocks.relayBatch.mockResolvedValue({ items: [{ index: 0, ok: true, data: { url: "u", key: "k" } }] });

    const [result] = await uploadBatchWithRetry([FILE]);

    expect(result.status).toBe("fulfilled");
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("复验失败 422：业务失败不重试不重传", async () => {
    stubApi(() => Promise.resolve(TICKET), () => Promise.reject(apiError(422, "upload.verify_failed")));

    const [result] = await uploadBatchWithRetry([FILE]);

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason.message).toBe("item failed");
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });

  it("ticket 429：按退避重试后成功", async () => {
    vi.useFakeTimers();
    let ticketCalls = 0;
    stubApi(
      () => {
        ticketCalls += 1;
        return ticketCalls === 1 ? Promise.reject(apiError(429, "upload.too_many_pending")) : Promise.resolve(TICKET);
      },
      () => Promise.resolve(COMPLETE),
    );

    const pending = uploadBatchWithRetry([FILE]);
    // 哈希经真实 WASM 异步完成：waitFor 自动推进假时钟直到首个 ticket 落地
    await vi.waitFor(() => expect(ticketCalls).toBe(1));
    // 1s 指数退避尚未到期不应重试（waitFor 的时钟推进有 tick 级漂移，探针留足余量），
    // 随后由 waitFor 继续推进假时钟跨过到期点，等待重试落地
    await vi.advanceTimersByTimeAsync(400);
    expect(ticketCalls).toBe(1);
    await vi.waitFor(() => expect(ticketCalls).toBe(2));
    const [result] = await pending;
    expect(result.status).toBe("fulfilled");
    expect(ticketCalls).toBe(2);
  });

  it("direct_unavailable：清 limits 缓存并按业务失败上报", async () => {
    stubApi(() => Promise.reject(apiError(409, "upload.direct_unavailable")), () => Promise.resolve(COMPLETE));

    const [result] = await uploadBatchWithRetry([FILE]);

    expect(result.status).toBe("rejected");
    expect(mocks.invalidateUploadLimits).toHaveBeenCalled();
  });

  it("进度按阶段逐文件归因：哈希阶段报已读字节，PUT 阶段报传输百分比", async () => {
    stubApi(() => Promise.resolve(TICKET), () => Promise.resolve(COMPLETE));
    const files = [new File(["hello"], "a.png", { type: "image/png" }), new File(["hello"], "b.png", { type: "image/png" })];
    const onProgress = vi.fn();
    mocks.put.mockImplementation(
      (_url: string, _body: File, _type: string | undefined, onProgressArg?: (pct: number, loaded: number) => void) => {
        // 传输层契约 (pct, loaded)：5 字节文件传到 3 字节时 pct=60、loaded=3
        onProgressArg?.(60, 3);
        return Promise.resolve();
      },
    );

    const results = await uploadBatchWithRetry(files, onProgress);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // 阶段契约：哈希阶段报 { hashing, 已读字节 }（含同步首报 0，UI 走不定态），
    // PUT 阶段报 { uploading, 百分比 }——3/5 字节即 60%（pct 单位错位回归防线）
    const valuesOf = (index: number) => onProgress.mock.calls.filter(([i]) => i === index).map(([, v]) => v);
    expect(valuesOf(0)).toContainEqual({ phase: "hashing", loadedBytes: 0 });
    expect(valuesOf(0)).toContainEqual({ phase: "hashing", loadedBytes: 5 });
    expect(valuesOf(0)).toContainEqual({ phase: "uploading", pct: 60 });
    expect(valuesOf(1)).toContainEqual({ phase: "hashing", loadedBytes: 0 });
    expect(valuesOf(1)).toContainEqual({ phase: "hashing", loadedBytes: 5 });
    expect(valuesOf(1)).toContainEqual({ phase: "uploading", pct: 60 });
    expect(valuesOf(0).at(-1)).toEqual({ phase: "uploading", pct: 100 });
    expect(valuesOf(1).at(-1)).toEqual({ phase: "uploading", pct: 100 });
  });

  it("PUT 网络中断：同 URL 同内容退避重试（spec 规则 6），不重开票据", async () => {
    vi.useFakeTimers();
    let putCalls = 0;
    mocks.put.mockImplementation(() => {
      putCalls += 1;
      return putCalls === 1 ? Promise.reject(new UploadTransportError("network", "net down")) : Promise.resolve();
    });
    stubApi(() => Promise.resolve(TICKET), () => Promise.resolve(COMPLETE));

    const pending = uploadBatchWithRetry([FILE]);
    await vi.waitFor(() => expect(putCalls).toBe(1));
    // 1s 指数退避尚未到期不应重试（waitFor 的时钟推进有 tick 级漂移，探针留足余量），
    // 随后由 waitFor 继续推进假时钟跨过到期点，等待重试落地
    await vi.advanceTimersByTimeAsync(400);
    expect(putCalls).toBe(1);
    await vi.waitFor(() => expect(putCalls).toBe(2));
    const [result] = await pending;
    expect(result.status).toBe("fulfilled");
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.put).toHaveBeenCalledTimes(2);
  });

  it("PUT 403（签名过期）：不可同 URL 重试，直接失败", async () => {
    mocks.put.mockRejectedValue(new UploadTransportError("http", "forbidden", 403));
    stubApi(() => Promise.resolve(TICKET), () => Promise.resolve(COMPLETE));

    const [result] = await uploadBatchWithRetry([FILE]);

    expect(result.status).toBe("rejected");
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
});

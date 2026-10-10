import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  persist: vi.fn(),
  save: vi.fn(),
  probeIntegrity: vi.fn(),
  probeMeta: vi.fn(),
}));

vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    MAX_UPLOAD_SIZE_MB: 1,
    UPLOAD_BATCH_MAX_FILES: 20,
    UPLOAD_BATCH_MAX_MB: 2,
    UPLOAD_BATCH_MAX_CONCURRENT: 1,
    UPLOAD_BATCH_MAX_PENDING: 2,
    UPLOAD_DIR: "uploads",
    LOG_LEVEL: "silent",
    ALLOW_INSECURE_SECRETS: true,
  }),
}));

vi.mock("@server/http/middleware/auth", () => ({
  authenticateRequest: mocks.authenticate,
}));

vi.mock("@server/services/storage/backends/local", () => ({
  localStorage: { baseDir: "", save: mocks.save, stat: vi.fn() },
}));

vi.mock("@server/services/storage/persist", () => ({
  persistFileObject: mocks.persist,
}));

vi.mock("@server/services/storage/media-probe", () => ({
  probeVideoIntegrity: mocks.probeIntegrity,
  probeVideoMetaCached: mocks.probeMeta,
}));

import { router } from "@server/http/routes/upload";

const MB = 1024 * 1024;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ user: { id: 1 } });
  mocks.persist.mockResolvedValue({ width: null, height: null, duration: null });
});

const errorOf = async (res: Response): Promise<{ error: string; ctx?: unknown }> =>
  (await res.json()) as { error: string; ctx?: unknown };

describe("POST /api/files/upload 体积校验", () => {
  it("Content-Length 已超限（含 multipart 余量）时 413，不进入 multipart 解析", async () => {
    // 声明 4MB > 2MB 批次限制 + 1MB 余量：必须在缓冲整个请求体之前拒绝
    const res = await router.request("/api/files/upload", {
      method: "POST",
      headers: { "content-length": String(4 * MB) },
      body: "x".repeat(1024),
    });
    expect(res.status).toBe(413);
    const body = await errorOf(res);
    expect(body.error).toBe("upload.batch_too_large");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("Content-Length 在余量内但单文件超限时返回逐项失败", async () => {
    // 1.5MB：请求总长低于 2MB 预检阈值，走到逐字段 size 校验才拒绝
    const form = new FormData();
    form.append("file", new File([new Uint8Array(1.5 * MB).fill(0x61)], "a.png", { type: "image/png" }));
    const res = await router.request("/api/files/upload", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ ok: boolean; error?: { code: string } }> } };
    expect(body.data.items[0]).toMatchObject({ ok: false, error: { code: "upload.file_too_large" } });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("一个请求返回批次内每个文件的独立结果", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    form.append("file", new File([new Uint8Array([4, 5, 6])], "b.png", { type: "image/png" }));

    const res = await router.request("/api/files/upload", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ index: number; ok: boolean }> } };
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items).toEqual([
      expect.objectContaining({ index: 0, ok: true }),
      expect.objectContaining({ index: 1, ok: true }),
    ]);
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });

  it("批次超过文件数上限时在解析后拒绝整个请求", async () => {
    const form = new FormData();
    for (let i = 0; i < 21; i++) {
      form.append("file", new File([new Uint8Array([1])], `${i}.png`, { type: "image/png" }));
    }

    const res = await router.request("/api/files/upload", { method: "POST", body: form });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).error).toBe("upload.batch_too_large");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("请求体在余量内但批次总字节超限时由 handler 复验拒绝", async () => {
    // 2 × 1.2MB = 2.4MB：超过 2MB 批次总字节上限，但低于 bodyLimit 的 3MB 预检阈值，
    // 必须走到 handler 的 totalBytes 复验分支才拒绝
    const form = new FormData();
    form.append("file", new File([new Uint8Array(1.2 * MB).fill(0x61)], "a.png", { type: "image/png" }));
    form.append("file", new File([new Uint8Array(1.2 * MB).fill(0x62)], "b.png", { type: "image/png" }));

    const res = await router.request("/api/files/upload", { method: "POST", body: form });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).error).toBe("upload.batch_too_large");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("重复内容文件复用同一存储对象（哈希幂等）", async () => {
    const form = new FormData();
    const content = new Uint8Array([7, 8, 9, 10]);
    form.append("file", new File([content], "a.png", { type: "image/png" }));
    form.append("file", new File([content], "b.png", { type: "image/png" }));

    const res = await router.request("/api/files/upload", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ index: number; ok: boolean }> } };
    expect(body.data.items.every((item) => item.ok)).toBe(true);
    // 相同内容 -> 相同哈希 -> 相同 storageKey；存储层与持久化各自按 key 幂等
    expect(mocks.save).toHaveBeenCalledTimes(2);
    const keys = mocks.save.mock.calls.map((call) => call[0]);
    expect(keys[0]).toBe(keys[1]);
  });

  it("混合合法、超限和不支持文件：合法成功，错误文件各自返回独立原因", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "ok.png", { type: "image/png" }));
    // SVG 已移出上传白名单：扩展名与 MIME 双双拒绝
    form.append("file", new File([new Uint8Array([1, 2, 3])], "vector.svg", { type: "image/svg+xml" }));
    form.append("file", new File([new Uint8Array(1.5 * MB)], "huge.png", { type: "image/png" }));

    const res = await router.request("/api/files/upload", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ index: number; ok: boolean; error?: { code: string } }> } };
    expect(body.data.items[0]).toMatchObject({ index: 0, ok: true });
    expect(body.data.items[1]).toMatchObject({ index: 1, ok: false, error: { code: "upload.unsupported_type" } });
    expect(body.data.items[2]).toMatchObject({ index: 2, ok: false, error: { code: "upload.file_too_large" } });
    // 仅合法文件落盘
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("未携带文件时请求级失败", async () => {
    const res = await router.request("/api/files/upload", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).error).toBe("upload.no_file");
  });

  it("文件数恰好在上限内时整批成功", async () => {
    const form = new FormData();
    for (let i = 0; i < 20; i++) {
      form.append("file", new File([new Uint8Array([i])], `${i}.png`, { type: "image/png" }));
    }

    const res = await router.request("/api/files/upload", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ ok: boolean }> } };
    expect(body.data.items).toHaveLength(20);
    expect(body.data.items.every((item) => item.ok)).toBe(true);
  });

  it("同一用户并发批次按 FIFO 排队，队列满时超额请求收到 429", async () => {
    mocks.authenticate.mockResolvedValue({ user: { id: 99 } });
    const saveOrder: string[] = [];
    let releaseSave!: () => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    const saveReleased = new Promise<void>((resolve) => { releaseSave = resolve; });
    mocks.save.mockImplementation(async (key: string) => {
      saveOrder.push(key);
      markSaveStarted();
      await saveReleased;
    });

    const formOf = (byte: number) => {
      const f = new FormData();
      f.append("file", new File([new Uint8Array([byte])], `${byte}.png`, { type: "image/png" }));
      return f;
    };
    // 并发 1：first 占用槽位，second/third 排队（UPLOAD_BATCH_MAX_PENDING=2），fourth 超额
    const first = router.request("/api/files/upload", { method: "POST", body: formOf(1) });
    await saveStarted;
    const second = router.request("/api/files/upload", { method: "POST", body: formOf(2) });
    const third = router.request("/api/files/upload", { method: "POST", body: formOf(3) });
    // 宏任务等待：微任务队列清空后 second/third 均已入队
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fourth = router.request("/api/files/upload", { method: "POST", body: formOf(4) });
    // 429 拒绝不依赖槽位，先于 releaseSave 确定性完成（避免与槽位释放竞争）
    const fourthRes = await fourth;
    expect(fourthRes.status).toBe(429);
    expect(((await fourthRes.json()) as { error: string }).error).toBe("upload.too_many_pending");
    // 验收标准：429 带可计算的重试信息
    expect(fourthRes.headers.get("Retry-After")).toBe("1");

    releaseSave();
    for (const r of [first, second, third]) expect((await r).status).toBe(200);

    // FIFO：save（即获得槽位）的顺序与排队顺序一致
    const keys = await Promise.all(
      [first, second, third].map(async (r) => {
        const body = (await (await r).json()) as { data: { items: Array<{ data: { key: string } }> } };
        return body.data.items[0].data.key;
      }),
    );
    expect(saveOrder).toEqual(keys);
  });

  it("无 Content-Length 的超限请求在达到批次上限后停止读取", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulls = 0;
    let readPastLimit = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 8) controller.close();
      },
      cancel() { readPastLimit = pulls > 4; },
    }, { highWaterMark: 0 });
    const request = new Request("http://localhost/api/files/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=missing" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await router.fetch(request);

    expect(response.status).toBe(413);
    expect(readPastLimit).toBe(false);
    expect(pulls).toBe(4);
  });

  it("队列已满时 chunked 请求在读取任何 body 字节前返回 429", async () => {
    const { waitForUserConcurrency } = await import("@server/core/ratelimit/concurrency");
    mocks.authenticate.mockResolvedValue({ user: { id: 201 } });
    const release = await waitForUserConcurrency("upload", 201, 1, undefined, 2);
    const waiting = [
      waitForUserConcurrency("upload", 201, 1, undefined, 2),
      waitForUserConcurrency("upload", 201, 1, undefined, 2),
    ];
    let pulled = 0;
    const request = new Request("http://localhost/api/files/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } }, { highWaterMark: 0 }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    try {
      const response = await router.fetch(request);
      expect(response.status).toBe(429);
      expect(pulled).toBe(0);
    } finally {
      release();
      for (const pending of waiting) (await pending)();
    }
  });

  it.each([
    ["vector.svg", "image/png", "<svg xmlns='http://www.w3.org/2000/svg'/>"],
    ["vector.png", "image/svg+xml", "<svg/>"],
    ["vector.png", "image/png", "<?xml version='1.0'?><!--comment--><svg/>"],
    ["vector.png", "image/png", " ".repeat(9000) + "<svg/>"],
  ])("拒绝 SVG 伪装：%s / %s", async (name, type, content) => {
    const form = new FormData();
    form.append("file", new File([content], name, { type }));
    const res = await router.request("/api/files/upload", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ ok: boolean; error?: { code: string } }> } };
    expect(body.data.items[0]).toMatchObject({ ok: false, error: { code: "upload.unsupported_type" } });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("拒绝 UTF-16 编码的改名 SVG", async () => {
    const form = new FormData();
    form.append("file", new File([Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<svg/>", "utf16le")])], "vector.png", { type: "image/png" }));
    const res = await router.request("/api/files/upload", { method: "POST", body: form });
    const body = (await res.json()) as { data: { items: Array<{ error?: { code: string } }> } };
    expect(body.data.items[0].error?.code).toBe("upload.unsupported_type");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("视频探测完成前不释放批次租约，完成后保留截断提示", async () => {
    mocks.authenticate.mockResolvedValue({ user: { id: 202 } });
    mocks.probeMeta.mockResolvedValue({ duration: 10 });
    let finish!: (result: { truncated: boolean; decodableDuration: number }) => void;
    mocks.probeIntegrity.mockImplementation(() => new Promise((r) => { finish = r; }));
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1])], "video.mp4", { type: "video/mp4" }));
    const video = router.request("/api/files/upload", { method: "POST", body: form });
    await vi.waitFor(() => expect(mocks.probeIntegrity).toHaveBeenCalledTimes(1));
    const imageForm = new FormData();
    imageForm.append("file", new File([new Uint8Array([2])], "image.png", { type: "image/png" }));
    const next = router.request("/api/files/upload", { method: "POST", body: imageForm });
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.probeIntegrity.mock.calls[0][2]).toBe(1500);
    finish({ truncated: true, decodableDuration: 5 });
    const res = await video;
    const body = (await res.json()) as { data: { items: Array<{ data?: { media_warning?: unknown } }> } };
    expect(body.data.items[0].data?.media_warning).toEqual({ declared: 10, decodable: 5 });
    expect((await next).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
});

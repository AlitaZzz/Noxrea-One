// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageLoadScheduler, type PreparedImage, prepareImage } from "@/features/canvas/services/image-load-scheduler";

const image = { url: "blob:test", width: 1600, height: 900 } satisfies PreparedImage;
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function controlledLoader() {
  const calls: Array<{ src: string; signal: AbortSignal; resolve: (image: PreparedImage) => void; reject: (error: Error) => void }> = [];
  const load = vi.fn((src: string, signal: AbortSignal) => new Promise<PreparedImage>((resolve, reject) => {
    calls.push({ src, signal, resolve, reject });
  }));
  return { calls, load };
}

let revokedUrls: string[];
beforeEach(() => {
  revokedUrls = [];
  // jsdom 未实现 Blob object URL：以可控静态方法替代， revoke 调用转为可断言记录
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => `blob:img-${Math.random()}`);
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn((url: string) => { revokedUrls.push(url); });
});
afterEach(() => {
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ImageLoadScheduler", () => {
  it("queues explicit recovery, ignores released retries and does not replay a stale failure", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load, 1);
    const notify = vi.fn();
    const lease = scheduler.acquire("shared", notify);
    lease.setPriority(0);
    await flush();
    calls[0].reject(new Error("temporary failure"));
    await flush();
    const lateNotify = vi.fn();
    const late = scheduler.acquire("shared", lateNotify);
    late.setPriority(0);
    lease.retry();
    late.retry();
    await flush();
    expect(lateNotify).not.toHaveBeenCalledWith({ status: "failed" });
    expect(calls).toHaveLength(2);
    calls[1].resolve(image);
    await flush();
    expect(notify).toHaveBeenLastCalledWith({ status: "ready", ...image });
    expect(lateNotify).toHaveBeenLastCalledWith({ status: "ready", ...image });
    lease.release();
    lease.retry();
    await flush();
    expect(calls).toHaveLength(2);
    scheduler.clear();
  });

  it("starts at most four jobs and prioritizes visible work over earlier prefetch requests", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load);
    for (let i = 0; i < 6; i++) scheduler.acquire(`prefetch-${i}`, vi.fn()).setPriority(1);
    scheduler.acquire("visible", vi.fn()).setPriority(0);
    await flush();
    expect(calls.map((call) => call.src)).toEqual(["visible", "prefetch-0", "prefetch-1", "prefetch-2"]);
    calls[0].resolve(image);
    await flush();
    expect(calls).toHaveLength(5);
    scheduler.clear();
  });

  it("keeps far-away images idle and removes queued work before it starts", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load, 1);
    scheduler.acquire("far", vi.fn());
    scheduler.acquire("active", vi.fn()).setPriority(0);
    const queued = scheduler.acquire("queued", vi.fn());
    queued.setPriority(1);
    await flush();
    queued.setPriority(null);
    calls[0].resolve(image);
    await flush();
    expect(calls.map((call) => call.src)).toEqual(["active"]);
    queued.setPriority(0);
    await flush();
    expect(calls[1].src).toBe("queued");
    scheduler.clear();
  });

  it("updates the priority of pending work when the viewport moves", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load, 1);
    scheduler.acquire("active", vi.fn()).setPriority(0);
    scheduler.acquire("first", vi.fn()).setPriority(1);
    const next = scheduler.acquire("next", vi.fn());
    next.setPriority(1);
    await flush();
    next.setPriority(0);
    calls[0].resolve(image);
    await flush();
    expect(calls[1].src).toBe("next");
    scheduler.clear();
  });

  it("shares a URL and cancels it only after the last interested consumer leaves", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load);
    const firstNotify = vi.fn();
    const secondNotify = vi.fn();
    const first = scheduler.acquire("shared", firstNotify);
    const second = scheduler.acquire("shared", secondNotify);
    first.setPriority(0);
    second.setPriority(1);
    await flush();
    expect(calls).toHaveLength(1);
    first.release();
    expect(calls[0].signal.aborted).toBe(false);
    calls[0].resolve(image);
    await flush();
    expect(firstNotify).not.toHaveBeenCalled();
    expect(secondNotify).toHaveBeenCalledWith({ status: "ready", ...image });
    second.setPriority(null);
    second.setPriority(0);
    await flush();
    expect(calls).toHaveLength(1);
    second.release();
  });

  it("does not publish cancelled results or free a running slot before the loader settles", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load, 1);
    const notify = vi.fn();
    const first = scheduler.acquire("old", notify);
    first.setPriority(0);
    await flush();
    first.setPriority(null);
    scheduler.acquire("new", vi.fn()).setPriority(0);
    await flush();
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    calls[0].resolve(image);
    await flush();
    expect(notify).not.toHaveBeenCalled();
    // load 在中止后才结算：complete 守卫丢弃的 ready 结果须就地撤销
    expect(revokedUrls).toEqual([image.url]);
    expect(calls[1].src).toBe("new");
    scheduler.clear();
  });

  it("releases failed slots and reports failure without automatic retries", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load, 1);
    const notify = vi.fn();
    const lease = scheduler.acquire("broken", notify);
    lease.setPriority(0);
    scheduler.acquire("next", vi.fn()).setPriority(0);
    await flush();
    calls[0].reject(new Error("bad image"));
    await flush();
    expect(notify).toHaveBeenCalledWith({ status: "failed" });
    expect(calls[1].src).toBe("next");
    lease.setPriority(null);
    lease.setPriority(0);
    await flush();
    expect(calls).toHaveLength(2);
    scheduler.clear();
  });

  it("clears the canvas and can be reused during Strict Mode effect replay", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load, 1);
    const oldNotify = vi.fn();
    scheduler.acquire("same", oldNotify).setPriority(0);
    await flush();
    scheduler.clear();
    const newNotify = vi.fn();
    scheduler.acquire("same", newNotify).setPriority(0);
    calls[0].resolve(image);
    await flush();
    expect(oldNotify).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    calls[1].resolve(image);
    await flush();
    expect(newNotify).toHaveBeenCalledWith({ status: "ready", ...image });
    scheduler.clear();
  });

  it("removes a released queued consumer without affecting another URL", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load);
    const released = scheduler.acquire("deleted", vi.fn());
    released.setPriority(0);
    released.release();
    scheduler.acquire("kept", vi.fn()).setPriority(0);
    await flush();
    expect(calls.map((call) => call.src)).toEqual(["kept"]);
    scheduler.clear();
  });

  it("revokes the ready object URL when the job is dropped and on clear", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load, 1);
    const notify = vi.fn();
    const lease = scheduler.acquire("dropped", notify);
    lease.setPriority(0);
    await flush();
    calls[0].resolve(image);
    await flush();
    expect(notify).toHaveBeenCalledWith({ status: "ready", ...image });
    lease.release();
    await flush();
    expect(revokedUrls).toEqual([image.url]);

    const kept = scheduler.acquire("kept", vi.fn());
    kept.setPriority(0);
    await flush();
    calls[1].resolve({ ...image, url: "blob:kept" });
    await flush();
    scheduler.clear();
    expect(revokedUrls).toEqual([image.url, "blob:kept"]);
  });

  it("keeps the object URL alive while the job survives a same-turn re-acquire", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load, 1);
    const lease = scheduler.acquire("shared", vi.fn());
    lease.setPriority(0);
    await flush();
    calls[0].resolve(image);
    await flush();
    lease.release();
    // 同一轮重新认领：job 复活，URL 不得被撤销
    scheduler.acquire("shared", vi.fn());
    await flush();
    expect(revokedUrls).toEqual([]);
    scheduler.clear();
    expect(revokedUrls).toEqual([image.url]);
  });
});

describe("prepareImage", () => {
  class FakeImage {
    static instances: FakeImage[] = [];
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = "";
    src = "";
    naturalWidth = image.width;
    naturalHeight = image.height;
    decode = vi.fn(() => Promise.resolve());
    removeAttribute = vi.fn();
    constructor() { FakeImage.instances.push(this); }
  }

  function stubFetchedResponse(response: { ok: boolean; status?: number } = { ok: true }) {
    const fetched: string[] = [];
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input));
      if (init?.signal) signals.push(init.signal);
      return Promise.resolve({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 404),
        blob: () => Promise.resolve(Object.assign(new Blob(["data"]), { source: String(input) })),
      });
    }));
    return { fetched, signals };
  }

  function stubHangingFetch() {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<never>(() => {});
    }));
    return signals;
  }

  beforeEach(() => {
    FakeImage.instances = [];
    vi.stubGlobal("Image", FakeImage);
  });

  it("waits for decode before declaring the image ready and hands out the object URL", async () => {
    stubFetchedResponse();
    const controller = new AbortController();
    let decodeDone!: () => void;
    const promise = prepareImage("/img.png", controller.signal);
    await flush();
    const probe = FakeImage.instances.at(-1)!;
    expect(probe.src).toMatch(/^blob:/);
    probe.decode.mockImplementation(() => new Promise<void>((resolve) => { decodeDone = resolve; }));
    const ready = vi.fn();
    void promise.then(ready);
    probe.onload!();
    await flush();
    expect(ready).not.toHaveBeenCalled();
    decodeDone();
    await expect(promise).resolves.toEqual({ url: probe.src, width: image.width, height: image.height });
    expect(probe.onload).toBeNull();
    expect(probe.onerror).toBeNull();
  });

  it("aborts during the probe phase and revokes the object URL", async () => {
    const { signals } = stubFetchedResponse();
    const controller = new AbortController();
    const promise = prepareImage("/img.png", controller.signal);
    await flush();
    const probe = FakeImage.instances.at(-1)!;
    const rejection = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(revokedUrls).toHaveLength(1);
    // 外部 abort 级联到内部 controller，传输同步取消
    expect(signals[0].aborted).toBe(true);
    expect(probe.removeAttribute).toHaveBeenCalledWith("src");
    expect(probe.onload).toBeNull();
    expect(probe.onerror).toBeNull();
  });

  it("aborts before the fetch resolves without creating or revoking any URL", async () => {
    const { signals } = stubFetchedResponse();
    const controller = new AbortController();
    const promise = prepareImage("/img.png", controller.signal);
    const rejection = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    await flush();
    expect(revokedUrls).toEqual([]);
    expect(FakeImage.instances).toHaveLength(0);
    expect(signals[0].aborted).toBe(true);
  });

  it("revokes the object URL when the probe fails to load the resource", async () => {
    stubFetchedResponse();
    const promise = prepareImage("/corrupt.png", new AbortController().signal);
    await flush();
    FakeImage.instances.at(-1)!.onerror!();
    await expect(promise).rejects.toThrow("Image load failed");
    expect(revokedUrls).toHaveLength(1);
    expect(FakeImage.instances.at(-1)!.onload).toBeNull();
  });

  it("revokes the object URL when decoding fails after load", async () => {
    stubFetchedResponse();
    const promise = prepareImage("/undecodable.png", new AbortController().signal);
    await flush();
    const probe = FakeImage.instances.at(-1)!;
    probe.decode.mockReturnValue(Promise.reject(new Error("decoding failed")));
    probe.onload!();
    await expect(promise).rejects.toThrow("decoding failed");
    expect(revokedUrls).toHaveLength(1);
    expect(probe.onerror).toBeNull();
  });

  it("reports failure without creating a URL for non-2xx responses", async () => {
    stubFetchedResponse({ ok: false, status: 404 });
    const promise = prepareImage("/missing.png", new AbortController().signal);
    await expect(promise).rejects.toThrow("failed (404)");
    expect(revokedUrls).toEqual([]);
    expect(FakeImage.instances).toHaveLength(0);
  });

  it("times out a stalled transfer, cancelling the in-flight fetch", async () => {
    const signals = stubHangingFetch();
    vi.useFakeTimers();
    const promise = prepareImage("stalled", new AbortController().signal);
    const rejection = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    // fetch 阶段超时：object URL 尚未创建、探测元素未挂载
    expect(revokedUrls).toEqual([]);
    expect(FakeImage.instances).toHaveLength(0);
    // 传输挂起中触发超时：fetch 的 signal 必须被中止，不得继续空跑剩余字节
    expect(signals[0].aborted).toBe(true);
  });

  it("times out a stalled probe after the transfer and revokes the object URL", async () => {
    stubFetchedResponse();
    vi.useFakeTimers();
    const promise = prepareImage("stalled-probe", new AbortController().signal);
    const rejection = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(revokedUrls).toHaveLength(1);
    expect(FakeImage.instances.at(-1)!.removeAttribute).toHaveBeenCalledWith("src");
  });
});

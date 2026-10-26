// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageLoadScheduler, type PreparedImage, prepareImage } from "@/features/canvas/services/image-load-scheduler";

const image = { url: "/img-1600x900", width: 1600, height: 900 } satisfies PreparedImage;
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function controlledLoader() {
  const calls: Array<{ src: string; signal: AbortSignal; resolve: (image: PreparedImage) => void; reject: (error: Error) => void }> = [];
  const load = vi.fn((src: string, signal: AbortSignal) => new Promise<PreparedImage>((resolve, reject) => {
    calls.push({ src, signal, resolve, reject });
  }));
  return { calls, load };
}

afterEach(() => {
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
    // complete 守卫丢弃被中止 job 的结果：不通知
    expect(notify).not.toHaveBeenCalled();
    // loader 结算后腾出并发槽，排队中的 "new" 随即启动
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

  it("counts an original image as three weight units and runs one at a time", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load);
    for (const src of ["original-a", "original-b"]) {
      const lease = scheduler.acquire(src, vi.fn());
      lease.setPriority(0);
      lease.setWeight(3);
    }
    await flush();
    expect(calls.map((call) => call.src)).toEqual(["original-a"]);
    calls[0].resolve(image);
    await flush();
    expect(calls[1].src).toBe("original-b");
    scheduler.clear();
  });

  it("runs two large tiers at once and queues the third", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load);
    for (const src of ["tier-a", "tier-b", "tier-c"]) {
      const lease = scheduler.acquire(src, vi.fn());
      lease.setPriority(0);
      lease.setWeight(2);
    }
    await flush();
    expect(calls.map((call) => call.src)).toEqual(["tier-a", "tier-b"]);
    scheduler.clear();
  });

  it("starts a light job next to three active units instead of blocking on a heavy queued job", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load);
    const original = scheduler.acquire("original", vi.fn());
    original.setPriority(0);
    original.setWeight(3);
    const heavy = scheduler.acquire("heavy", vi.fn());
    heavy.setPriority(0);
    heavy.setWeight(2);
    const light = scheduler.acquire("light", vi.fn());
    light.setPriority(1);
    light.setWeight(1);
    await flush();
    // 重量 2 的排队任务装不下，但重量 1 的仍要启动，不能被它堵住
    expect(calls.map((call) => call.src)).toEqual(["original", "light"]);
    scheduler.clear();
  });

  it("bills a shared job by its heaviest consumer", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load);
    const light = scheduler.acquire("shared", vi.fn());
    light.setPriority(0);
    light.setWeight(1);
    const heavy = scheduler.acquire("shared", vi.fn());
    heavy.setPriority(0);
    heavy.setWeight(3);
    const other = scheduler.acquire("other", vi.fn());
    other.setPriority(0);
    other.setWeight(2);
    await flush();
    // 共享 job 按重量 3 计费：3 + 2 > 4，另一张大档位必须等待
    expect(calls.map((call) => call.src)).toEqual(["shared"]);
    calls[0].resolve(image);
    await flush();
    expect(calls[1].src).toBe("other");
    scheduler.clear();
  });

  it("upgrades a running job's weight without restarting and releases the raised weight", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load);
    const upgraded = scheduler.acquire("upgraded", vi.fn());
    upgraded.setPriority(0);
    upgraded.setWeight(1);
    await flush();
    expect(calls).toHaveLength(1);
    upgraded.setWeight(3);
    const heavy = scheduler.acquire("heavy", vi.fn());
    heavy.setPriority(0);
    heavy.setWeight(2);
    await flush();
    // 升重立即计入活跃重量（3 + 2 > 4），已开始的解码不重启
    expect(calls).toHaveLength(1);
    calls[0].resolve(image);
    await flush();
    expect(calls[1].src).toBe("heavy");
    scheduler.clear();
  });

  it("keeps a running job's raised weight charged after the heavy consumer leaves", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load);
    const heavy = scheduler.acquire("shared", vi.fn());
    heavy.setPriority(0);
    heavy.setWeight(3);
    const remaining = scheduler.acquire("shared", vi.fn());
    remaining.setPriority(0);
    remaining.setWeight(1);
    await flush();
    heavy.release();
    const other = scheduler.acquire("other", vi.fn());
    other.setPriority(0);
    other.setWeight(2);
    await flush();
    // 该次运行按启动时的重量 3 计费，消费者离开不会提前释放
    expect(calls).toHaveLength(1);
    calls[0].resolve(image);
    await flush();
    expect(calls[1].src).toBe("other");
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

  it("keeps the job alive across a same-turn re-acquire and reloads only after the job is dropped", async () => {
    const { calls, load } = controlledLoader();
    const scheduler = new ImageLoadScheduler(load, 1);
    const lease = scheduler.acquire("shared", vi.fn());
    lease.setPriority(0);
    await flush();
    calls[0].resolve(image);
    await flush();
    lease.release();
    // 同一轮重新认领：job 复活，不重新加载
    scheduler.acquire("shared", vi.fn());
    await flush();
    expect(calls).toHaveLength(1);
    scheduler.clear();
    const reloaded = scheduler.acquire("shared", vi.fn());
    reloaded.setPriority(0);
    await flush();
    expect(calls).toHaveLength(2);
    calls[1].resolve(image);
    await flush();
    scheduler.clear();
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

  beforeEach(() => {
    FakeImage.instances = [];
    vi.stubGlobal("Image", FakeImage);
  });

  it("waits for decode before declaring ready and resolves the original URL unchanged", async () => {
    const controller = new AbortController();
    let decodeDone!: () => void;
    const promise = prepareImage("/img.png", controller.signal);
    await flush();
    const probe = FakeImage.instances.at(-1)!;
    expect(probe.src).toBe("/img.png");
    expect(probe.decoding).toBe("async");
    probe.decode.mockImplementation(() => new Promise<void>((resolve) => { decodeDone = resolve; }));
    const ready = vi.fn();
    void promise.then(ready);
    probe.onload!();
    await flush();
    expect(ready).not.toHaveBeenCalled();
    decodeDone();
    await expect(promise).resolves.toEqual({ url: "/img.png", width: image.width, height: image.height });
    expect(probe.onload).toBeNull();
    expect(probe.onerror).toBeNull();
  });

  it("rejects immediately without creating a probe when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(prepareImage("/img.png", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeImage.instances).toHaveLength(0);
  });

  it("cancels the in-flight request when aborted during the probe", async () => {
    const controller = new AbortController();
    const promise = prepareImage("/img.png", controller.signal);
    await flush();
    const probe = FakeImage.instances.at(-1)!;
    const rejection = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(probe.removeAttribute).toHaveBeenCalledWith("src");
    expect(probe.onload).toBeNull();
    expect(probe.onerror).toBeNull();
  });

  it("cancels the in-flight request when the probe fails to load the resource", async () => {
    const promise = prepareImage("/corrupt.png", new AbortController().signal);
    await flush();
    FakeImage.instances.at(-1)!.onerror!();
    await expect(promise).rejects.toThrow("Image load failed");
    expect(FakeImage.instances.at(-1)!.removeAttribute).toHaveBeenCalledWith("src");
    expect(FakeImage.instances.at(-1)!.onload).toBeNull();
  });

  it("fails when decoding fails after load", async () => {
    const promise = prepareImage("/undecodable.png", new AbortController().signal);
    await flush();
    const probe = FakeImage.instances.at(-1)!;
    probe.decode.mockReturnValue(Promise.reject(new Error("decoding failed")));
    probe.onload!();
    await expect(promise).rejects.toThrow("decoding failed");
    expect(probe.removeAttribute).toHaveBeenCalledWith("src");
    expect(probe.onerror).toBeNull();
  });

  it("times out a stalled probe and cancels the in-flight request", async () => {
    vi.useFakeTimers();
    const promise = prepareImage("stalled", new AbortController().signal);
    const rejection = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(FakeImage.instances.at(-1)!.removeAttribute).toHaveBeenCalledWith("src");
    expect(FakeImage.instances.at(-1)!.onload).toBeNull();
  });

  it("passes blob preview URLs through without fetching or transforming them", async () => {
    const promise = prepareImage("blob:upload-preview", new AbortController().signal);
    await flush();
    const probe = FakeImage.instances.at(-1)!;
    expect(probe.src).toBe("blob:upload-preview");
    probe.onload!();
    await flush();
    await expect(promise).resolves.toEqual({ url: "blob:upload-preview", width: image.width, height: image.height });
  });
});

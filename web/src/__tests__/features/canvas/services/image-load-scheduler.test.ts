// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageLoadScheduler, type PreparedImage,prepareImage } from "@/features/canvas/services/image-load-scheduler";

const size = { width: 1600, height: 900 };
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function controlledLoader() {
  const calls: Array<{ src: string; signal: AbortSignal; resolve: (size: PreparedImage) => void; reject: (error: Error) => void }> = [];
  const load = vi.fn((src: string, signal: AbortSignal) => new Promise<PreparedImage>((resolve, reject) => {
    calls.push({ src, signal, resolve, reject });
  }));
  return { calls, load };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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
    calls[1].resolve(size);
    await flush();
    expect(notify).toHaveBeenLastCalledWith({ status: "ready", size });
    expect(lateNotify).toHaveBeenLastCalledWith({ status: "ready", size });
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
    calls[0].resolve(size);
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
    calls[0].resolve(size);
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
    calls[0].resolve(size);
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
    calls[0].resolve(size);
    await flush();
    expect(firstNotify).not.toHaveBeenCalled();
    expect(secondNotify).toHaveBeenCalledWith({ status: "ready", size });
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
    calls[0].resolve(size);
    await flush();
    expect(notify).not.toHaveBeenCalled();
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
    calls[0].resolve(size);
    await flush();
    expect(oldNotify).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    calls[1].resolve(size);
    await flush();
    expect(newNotify).toHaveBeenCalledWith({ status: "ready", size });
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
});

describe("prepareImage", () => {
  class FakeImage {
    static instances: FakeImage[] = [];
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = "";
    src = "";
    naturalWidth = size.width;
    naturalHeight = size.height;
    decode = vi.fn(() => Promise.resolve());
    removeAttribute = vi.fn();
    constructor() { FakeImage.instances.push(this); }
  }

  it("waits for decode before declaring the image ready", async () => {
    vi.stubGlobal("Image", FakeImage);
    const controller = new AbortController();
    let decodeDone!: () => void;
    const promise = prepareImage("image", controller.signal);
    const image = FakeImage.instances.at(-1)!;
    image.decode.mockImplementation(() => new Promise<void>((resolve) => { decodeDone = resolve; }));
    const ready = vi.fn();
    void promise.then(ready);
    image.onload!();
    await flush();
    expect(ready).not.toHaveBeenCalled();
    decodeDone();
    await expect(promise).resolves.toEqual(size);
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });

  it("aborts loading and removes handlers and the source", async () => {
    vi.stubGlobal("Image", FakeImage);
    const controller = new AbortController();
    const promise = prepareImage("image", controller.signal);
    const rejection = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    const image = FakeImage.instances.at(-1)!;
    controller.abort();
    await rejection;
    expect(image.removeAttribute).toHaveBeenCalledWith("src");
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });

  it("times out a stalled image", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Image", FakeImage);
    const promise = prepareImage("stalled", new AbortController().signal);
    const rejection = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(FakeImage.instances.at(-1)!.removeAttribute).toHaveBeenCalledWith("src");
  });
});

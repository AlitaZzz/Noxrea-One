// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VideoLoadScheduler } from "@/features/canvas/services/video-load-scheduler";

function player() {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { value: 0, configurable: true });
  return video;
}
function ready(video: HTMLVideoElement, state: number) {
  Object.defineProperty(video, "readyState", { value: state, configurable: true });
  video.dispatchEvent(new Event(state >= 2 ? "loadeddata" : "loadedmetadata"));
}
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }
let scheduler: VideoLoadScheduler;
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  scheduler = new VideoLoadScheduler(1);
});
afterEach(() => { scheduler.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("VideoLoadScheduler", () => {
  it("keeps distant players source-free and chooses visible work before metadata prefetch", async () => {
    const far = player(), near = player(), visible = player();
    scheduler.acquire(far, "/far.mp4", vi.fn());
    const nearby = scheduler.acquire(near, "/near.mp4", vi.fn());
    nearby.setPriority(1);
    scheduler.acquire(visible, "/visible.mp4", vi.fn()).setPriority(0);
    await flush();
    expect(far.hasAttribute("src")).toBe(false);
    expect(near.hasAttribute("src")).toBe(false);
    expect(visible.getAttribute("src")).toBe("/visible.mp4");
    expect(visible.preload).toBe("auto");
    ready(visible, 1);
    await flush();
    expect(near.hasAttribute("src")).toBe(false);
    ready(visible, 2);
    await flush();
    expect(visible.preload).toBe("metadata");
    expect(near.getAttribute("src")).toBe("/near.mp4");
    expect(near.preload).toBe("metadata");
  });

  it("releases metadata slots, queues first-frame upgrades and preserves time without reloading", async () => {
    const near = player(), visible = player();
    const nearby = scheduler.acquire(near, "/near.mp4", vi.fn());
    nearby.setPriority(1);
    await flush();
    ready(near, 1);
    scheduler.acquire(visible, "/visible.mp4", vi.fn()).setPriority(0);
    await flush();
    near.currentTime = 7;
    nearby.setPriority(0);
    await flush();
    expect(near.preload).toBe("metadata");
    ready(visible, 2);
    await flush();
    expect(near.preload).toBe("auto");
    ready(near, 2);
    nearby.setPriority(null);
    await flush();
    expect(near.getAttribute("src")).toBe("/near.mp4");
    expect(near.currentTime).toBe(7);
    expect(near.load).not.toHaveBeenCalled();
    expect(near.pause).not.toHaveBeenCalled();
  });

  it("drops queued distant work while retaining already-started sources", async () => {
    const first = player(), second = player();
    const firstLease = scheduler.acquire(first, "/first.mp4", vi.fn());
    const secondLease = scheduler.acquire(second, "/second.mp4", vi.fn());
    firstLease.setPriority(0);
    secondLease.setPriority(0);
    await flush();
    firstLease.setPriority(null);
    secondLease.setPriority(null);
    ready(first, 1);
    await flush();
    expect(first.getAttribute("src")).toBe("/first.mp4");
    expect(second.hasAttribute("src")).toBe(false);
  });

  it("admits user actions synchronously even when preparation slots are occupied", async () => {
    const first = player(), urgent = player();
    scheduler.acquire(first, "/first.mp4", vi.fn()).setPriority(0);
    const lease = scheduler.acquire(urgent, "/urgent.mp4", vi.fn());
    await flush();
    lease.setPriority(-1);
    expect(urgent.getAttribute("src")).toBe("/urgent.mp4");
    expect(urgent.preload).toBe("auto");
  });

  it("releases a departing player's preparation slot before any metadata arrives", async () => {
    const departing = player(), waiting = player();
    const lease = scheduler.acquire(departing, "/departing.mp4", vi.fn());
    lease.setPriority(0);
    scheduler.acquire(waiting, "/waiting.mp4", vi.fn()).setPriority(0);
    await flush();
    expect(waiting).not.toHaveAttribute("src");
    lease.setPriority(null);
    await flush();
    expect(departing.preload).toBe("none");
    expect(departing).toHaveAttribute("src", "/departing.mp4");
    expect(waiting).toHaveAttribute("src", "/waiting.mp4");
    expect(departing.load).not.toHaveBeenCalled();
  });

  it("leaves editor proxy sources intact and ignores their loading failures", async () => {
    const video = player();
    const notify = vi.fn();
    const lease = scheduler.acquire(video, "/original.mp4", notify);
    lease.setPriority(-1);
    video.src = "/proxy.mp4";
    video.preload = "auto";
    video.dispatchEvent(new Event("loadstart"));
    lease.setPriority(null);
    video.dispatchEvent(new Event("error"));
    ready(video, 2);
    await flush();
    expect(video.getAttribute("src")).toBe("/proxy.mp4");
    expect(video.preload).toBe("auto");
    expect(notify).not.toHaveBeenCalledWith("failed");
    video.src = "/original.mp4";
    ready(video, 2);
    expect(notify).toHaveBeenLastCalledWith("ready");
  });

  it("unblocks the queue on errors without silently retrying", async () => {
    const broken = player(), next = player();
    const notify = vi.fn();
    const lease = scheduler.acquire(broken, "/broken.mp4", notify);
    lease.setPriority(0);
    scheduler.acquire(next, "/next.mp4", vi.fn()).setPriority(0);
    await flush();
    broken.dispatchEvent(new Event("error"));
    await flush();
    expect(notify).toHaveBeenLastCalledWith("failed");
    expect(next.getAttribute("src")).toBe("/next.mp4");
    lease.setPriority(-1);
    expect(notify).toHaveBeenLastCalledWith("failed");
    ready(broken, 2);
    expect(notify).toHaveBeenLastCalledWith("ready");
  });

  it("retries only on explicit demand and leaves editor-owned proxy sources intact", async () => {
    const video = player();
    const notify = vi.fn();
    const lease = scheduler.acquire(video, "/original.mp4", notify);
    lease.setPriority(0);
    await flush();
    video.dispatchEvent(new Event("error"));
    lease.setPriority(null);
    lease.setPriority(0);
    await flush();
    expect(video.load).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith("failed");
    video.src = "/proxy.mp4";
    lease.retry();
    expect(video.load).not.toHaveBeenCalled();
    expect(video).toHaveAttribute("src", "/proxy.mp4");
    video.src = "/original.mp4";
    lease.retry();
    await flush();
    expect(video.load).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenLastCalledWith("loading");
    ready(video, 2);
    expect(notify).toHaveBeenLastCalledWith("ready");
    lease.retry();
    expect(video.load).toHaveBeenCalledOnce();
  });

  it("bounds stalled preparation and frees its slot", async () => {
    vi.useFakeTimers();
    const stalled = player(), next = player();
    const notify = vi.fn();
    scheduler.acquire(stalled, "/stalled.mp4", notify).setPriority(0);
    scheduler.acquire(next, "/next.mp4", vi.fn()).setPriority(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notify).toHaveBeenLastCalledWith("stalled");
    expect(next.getAttribute("src")).toBe("/next.mp4");
    ready(stalled, 2);
    expect(notify).toHaveBeenLastCalledWith("ready");
  });

  it("reports current readiness when an editor restores the original source", async () => {
    const video = player();
    const notify = vi.fn();
    const lease = scheduler.acquire(video, "/original.mp4", notify);
    lease.setPriority(-1);
    ready(video, 2);
    video.src = "/proxy.mp4";
    Object.defineProperty(video, "readyState", { value: 0, configurable: true });
    video.dispatchEvent(new Event("loadstart"));
    expect(notify).toHaveBeenLastCalledWith("loading");
    ready(video, 2);
    video.src = "/original.mp4";
    Object.defineProperty(video, "readyState", { value: 0, configurable: true });
    video.dispatchEvent(new Event("loadstart"));
    lease.setPriority(-1);
    expect(notify).toHaveBeenLastCalledWith("loading");
    ready(video, 2);
    expect(notify).toHaveBeenLastCalledWith("ready");
  });

  it("releases listeners, sources and queued work on disposal", async () => {
    const video = player(), queued = player();
    const notify = vi.fn();
    const lease = scheduler.acquire(video, "/video.mp4", notify);
    lease.setPriority(0);
    scheduler.acquire(queued, "/queued.mp4", vi.fn()).setPriority(0);
    await flush();
    scheduler.clear();
    notify.mockClear();
    ready(video, 2);
    lease.setPriority(-1);
    lease.release();
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(video.hasAttribute("src")).toBe(false);
    expect(queued.hasAttribute("src")).toBe(false);
    expect(video.pause).toHaveBeenCalled();
    expect(video.load).toHaveBeenCalled();
  });
});

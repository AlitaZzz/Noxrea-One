import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@server/core/config", () => ({ getConfig: () => ({ FFMPEG_PATH: "ffmpeg" }) }));
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));
import { probeFfmpeg, runFfmpeg, runFfprobe, scanFfprobe } from "@server/services/storage/ffmpeg";

let child: EventEmitter & { stderr: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
const scanPackets = (args: string[], timeout: number, opts: Parameters<typeof runFfmpeg>[2]) => scanFfprobe(args, timeout, { ...opts, section: "packets", onEntry: () => {} });
beforeEach(() => {
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit("close", null)); return true; });
  mocks.spawn.mockReturnValue(child);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("FFmpeg process lifecycle", () => {
  it("waits for process closure when an entry validator rejects streamed output", async () => {
    child.kill.mockReturnValue(true);
    const completed = vi.fn();
    const result = scanFfprobe([], 100, { section: "frames", onEntry: () => { throw new Error("Invalid frame timestamp"); } }).catch(completed);
    child.stdout.write('{"frames":[{}]}');
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(completed).not.toHaveBeenCalled();
    child.emit("close", null);
    await result;
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ message: "Invalid frame timestamp" }));
  });

  it("rejects incomplete streamed JSON after the process closes", async () => {
    const result = scanPackets([], 100, {});
    child.stdout.write('{"packets":[{"pts":1');
    child.emit("close", 0);
    await expect(result).rejects.toThrow();
  });

  it("preserves cancellation during streamed parser failure cleanup", async () => {
    child.kill.mockReturnValue(true);
    const controller = new AbortController();
    const result = scanPackets([], 100, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    child.stdout.write("invalid JSON");
    controller.abort();
    child.emit("close", null);
    await rejected;
  });

  it("streams packet metadata larger than 16 MiB without collecting the entire index", async () => {
    let count = 0;
    let last: unknown;
    const result = scanFfprobe([], 1000, { section: "packets", onEntry: (entry) => { count += 1; last = entry; } });
    child.stdout.write('{"packets":[');
    const block = '{"pts":1,"flags":"__"},'.repeat(4096);
    expect(Buffer.byteLength(block) * 200).toBeGreaterThan(16 * 1024 * 1024);
    for (let i = 0; i < 200; i++) child.stdout.write(block);
    child.stdout.write('{"pts":2,"flags":"K_"}]}');
    child.emit("close", 0);
    await result;
    expect(count).toBe(4096 * 200 + 1);
    expect(last).toEqual({ pts: 2, flags: "K_" });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("parses structured probe output and uses the configured sibling executable", async () => {
    const result = runFfprobe(["-of", "json"], 100);
    child.stdout.write('{"frames":[');
    child.stdout.write('{"best_effort_timestamp":123}]}');
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ frames: [{ best_effort_timestamp: 123 }] });
    expect(mocks.spawn.mock.calls[0][0]).toMatch(/ffprobe(?:\.exe)?$/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects invalid JSON rather than returning partial probe metadata", async () => {
    const result = runFfprobe([], 100);
    child.stdout.write('{"frames":[');
    child.emit("close", 0);
    await expect(result).rejects.toBeInstanceOf(SyntaxError);
  });

  it("kills an oversized probe and waits for closure before rejecting", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const completed = vi.fn();
    child.kill.mockReturnValue(true);
    const result = runFfprobe([], 100, { signal: controller.signal }).catch(completed);
    child.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1));
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(completed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", null);
    await result;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("metadata budget") }));
  });

  it("settles a timed-out probe and preserves its partial diagnostics", async () => {
    const completed = vi.fn();
    const result = probeFfmpeg([], 100).then(completed);
    child.stderr.write("partial probe");
    await vi.advanceTimersByTimeAsync(100);
    expect(completed).toHaveBeenCalledWith({ stderr: "partial probe", killed: true, spawnFailed: false });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await result;
  });

  it.each([runFfmpeg, probeFfmpeg, runFfprobe, scanPackets])("cancels an active process and removes its abort listener", async (execute) => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = execute([], 100, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([runFfmpeg, probeFfmpeg, runFfprobe, scanPackets])("does not spawn an already-cancelled operation", async (execute) => {
    const controller = new AbortController();
    controller.abort();
    await expect(execute([], 100, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("removes the run abort listener on timeout", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = expect(runFfmpeg([], 100, { signal: controller.signal })).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("waits for process closure before returning cancellation to the file-cleanup caller", async () => {
    const controller = new AbortController();
    const completed = vi.fn();
    child.kill.mockReturnValue(true);
    const result = runFfmpeg([], 100, { signal: controller.signal }).catch(completed);
    controller.abort();
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    child.emit("close", null);
    await result;
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" }));
  });

  it.each([runFfmpeg, probeFfmpeg, runFfprobe, scanPackets])("preserves cancellation when a spawn error arrives after abort", async (execute) => {
    const controller = new AbortController();
    child.kill.mockReturnValue(true);
    const result = execute([], 100, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    child.emit("error", new Error("spawn failed"));
    child.emit("close", null);
    await rejected;
  });
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
const poolMocks = vi.hoisted(() => ({ acquireHeavySlot: vi.fn(), acquireMediaSlot: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@server/core/config", () => ({ getConfig: () => ({ FFMPEG_PATH: "ffmpeg" }) }));
vi.mock("@server/services/storage/media-pool", () => ({
  acquireHeavySlot: poolMocks.acquireHeavySlot,
  acquireMediaSlot: poolMocks.acquireMediaSlot,
}));
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));
import { probeFfmpeg, probeFfmpegDecode, runFfmpegHeavy, runFfmpegLight, runFfprobe, scanFfprobe } from "@server/services/storage/ffmpeg";
const { MediaPoolBusyError } = await vi.importActual<typeof import("@server/services/storage/media-pool")>("@server/services/storage/media-pool");

let child: EventEmitter & { stderr: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
const scanPackets = (args: string[], timeout: number, opts: Parameters<typeof runFfmpegLight>[2]) => scanFfprobe(args, timeout, { ...opts, section: "packets", onEntry: () => {} });

/** 受控入口先异步取槽位再 spawn：让出一个微任务后子进程必须已启动，否则用例测的不是运行中的进程 */
async function spawned(): Promise<void> {
  await Promise.resolve();
  expect(mocks.spawn).toHaveBeenCalledOnce();
}
beforeEach(() => {
  vi.useFakeTimers();
  poolMocks.acquireHeavySlot.mockResolvedValue(vi.fn());
  poolMocks.acquireMediaSlot.mockResolvedValue(vi.fn());
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

  it.each([runFfmpegLight, probeFfmpeg, runFfprobe, scanPackets])("cancels an active process and removes its abort listener", async (execute) => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = execute([], 100, { signal: controller.signal });
    await Promise.resolve();
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([runFfmpegLight, probeFfmpeg, runFfprobe, scanPackets])("does not spawn an already-cancelled operation", async (execute) => {
    const controller = new AbortController();
    controller.abort();
    await expect(execute([], 100, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("removes the run abort listener on timeout", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = expect(runFfmpegLight([], 100, { signal: controller.signal })).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("waits for process closure before returning cancellation to the file-cleanup caller", async () => {
    const controller = new AbortController();
    const completed = vi.fn();
    child.kill.mockReturnValue(true);
    const result = runFfmpegLight([], 100, { signal: controller.signal }).catch(completed);
    await spawned();
    controller.abort();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(completed).not.toHaveBeenCalled();
    child.emit("close", null);
    await result;
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" }));
  });

  it.each([runFfmpegLight, probeFfmpeg, runFfprobe, scanPackets])("rejects with AbortError even when the abort reason is a string", async (execute) => {
    const reason = "Client connection prematurely closed.";
    const controller = new AbortController();
    const rejected = expect(execute([], 100, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError", cause: reason });
    await spawned();
    controller.abort(reason);
    await rejected;

    const preAborted = new AbortController();
    preAborted.abort(reason);
    await expect(execute([], 100, { signal: preAborted.signal }))
      .rejects.toMatchObject({ name: "AbortError", cause: reason });
  });

  it.each([runFfmpegLight, probeFfmpeg, runFfprobe, scanPackets])("preserves cancellation when a spawn error arrives after abort", async (execute) => {
    const controller = new AbortController();
    child.kill.mockReturnValue(true);
    const result = execute([], 100, { signal: controller.signal });
    await spawned();
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    child.emit("error", new Error("spawn failed"));
    child.emit("close", null);
    await rejected;
  });
});


describe("FFmpeg 并发门集成", () => {
  it("轻型任务先取轻型池槽位，进程结束后释放", async () => {
    const release = vi.fn();
    poolMocks.acquireMediaSlot.mockResolvedValue(release);
    const result = runFfmpegLight([], 100);
    await Promise.resolve();
    await Promise.resolve();
    expect(poolMocks.acquireMediaSlot).toHaveBeenCalledWith("ffmpeg_light", undefined);
    expect(poolMocks.acquireHeavySlot).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    child.emit("close", 0);
    await result;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("轻型池过载时立即拒绝且不启动子进程", async () => {
    poolMocks.acquireMediaSlot.mockRejectedValue(new MediaPoolBusyError("ffmpeg_light", "global", "queue_full"));
    await expect(runFfmpegLight([], 100)).rejects.toBeInstanceOf(MediaPoolBusyError);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("重型任务按属主取两级名额，进程结束后释放", async () => {
    const release = vi.fn();
    poolMocks.acquireHeavySlot.mockResolvedValue(release);
    const result = runFfmpegHeavy([], 100, { owner: 7 });
    await Promise.resolve();
    await Promise.resolve();
    expect(poolMocks.acquireHeavySlot).toHaveBeenCalledWith(7, undefined);
    expect(poolMocks.acquireMediaSlot).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    child.emit("close", 0);
    await result;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("全量解码入口（probeFfmpegDecode）按属主占重型池，结束后释放", async () => {
    const release = vi.fn();
    poolMocks.acquireHeavySlot.mockResolvedValue(release);
    const result = probeFfmpegDecode([], 100, { owner: 3 });
    await Promise.resolve();
    await Promise.resolve();
    expect(poolMocks.acquireHeavySlot).toHaveBeenCalledWith(3, undefined);
    expect(release).not.toHaveBeenCalled();
    child.emit("close", 0);
    await result;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["user", "queue_full"] as const,
    ["global", "wait_timeout"] as const,
  ])("重型池过载（scope=%s）时不启动子进程，错误原样向上抛", async (scope, reason) => {
    poolMocks.acquireHeavySlot.mockRejectedValue(new MediaPoolBusyError("ffmpeg_heavy", scope, reason));
    await expect(runFfmpegHeavy([], 100, { owner: 1 })).rejects.toMatchObject({ scope, reason });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("排队中止不启动子进程也不泄漏槽位", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    poolMocks.acquireHeavySlot.mockRejectedValue(abort);
    await expect(runFfmpegHeavy([], 100, { owner: 1 })).rejects.toBe(abort);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("槽位在超时被杀后同样释放", async () => {
    const release = vi.fn();
    poolMocks.acquireMediaSlot.mockResolvedValue(release);
    const result = expect(runFfmpegLight([], 100)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("运行中被中止：子进程关闭后释放槽位", async () => {
    const release = vi.fn();
    poolMocks.acquireMediaSlot.mockResolvedValue(release);
    const controller = new AbortController();
    const result = expect(runFfmpegLight([], 100, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await spawned();
    controller.abort();
    await result;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("spawn 失败后释放槽位", async () => {
    const release = vi.fn();
    poolMocks.acquireMediaSlot.mockResolvedValue(release);
    const result = expect(runFfmpegLight([], 100)).rejects.toThrow("spawn ffmpeg ENOENT");
    await spawned();
    child.emit("error", new Error("spawn ffmpeg ENOENT"));
    child.emit("close", -2);
    await result;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("排队时间不计入超时：取到槽位后才开始计时，享有完整超时预算", async () => {
    const release = vi.fn();
    poolMocks.acquireMediaSlot.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(release), 5_000)),
    );
    const result = expect(runFfmpegLight([], 100)).rejects.toThrow("timed out");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(99);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await result;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([probeFfmpeg, runFfprobe, scanPackets])("探测路径豁免并发池", async (execute) => {
    const result = execute([], 100, {});
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(poolMocks.acquireMediaSlot).not.toHaveBeenCalled();
    expect(poolMocks.acquireHeavySlot).not.toHaveBeenCalled();
    child.stdout.write('{"frames":[]}');
    child.emit("close", 0);
    await result;
  });
});

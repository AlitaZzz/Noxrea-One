/**
 * 媒体池并发实测：用真实 ffmpeg 子进程验证「上限 / 排队 / 拒绝 / 等待超时 / 排队中止」
 * （specs/media-processing-concurrency.md）。每个任务用 -re 按实时速度编码，
 * 耗时与机器快慢无关，任务之间稳定重叠；时间断言以启动前实测的单任务耗时为基准。
 * ffmpeg 目录取 FFMPEG_TEST_DIR，缺省为仓库 bin/；找不到 ffmpeg 时整体跳过。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ffmpegDir = vi.hoisted(() => process.env.FFMPEG_TEST_DIR ?? `${process.cwd()}/bin`);
const live = vi.hoisted(() => ({ current: 0, peak: 0, spawned: 0 }));
const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock("@server/core/config", () => ({ getConfig: () => ({ FFMPEG_PATH: ffmpegDir }) }));
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));
vi.mock("@server/core/settings", () => ({ getSetting: (key: string) => settings.values[key] }));
// 透传真实 spawn，只统计「同一时刻存活的 ffmpeg 子进程数」
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      live.spawned += 1;
      live.current += 1;
      live.peak = Math.max(live.peak, live.current);
      child.once("close", () => { live.current -= 1; });
      return child;
    }) as typeof actual.spawn,
  };
});

const bin = path.resolve(ffmpegDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const available = spawnSync(bin, ["-version"]).status === 0;

const JOB_ARGS = ["-v", "error", "-re", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=10:d=1.2", "-f", "null", "-"];

/** 单个任务的实测耗时（含进程启动）：各场景的时间断言以它为基准，而不是硬编码 */
let jobMs = 0;

function configure(maxConcurrency: number, maxPending: number, maxWaitSeconds: number): void {
  settings.values = {
    "media.ffmpeg_heavy_max_concurrency": maxConcurrency,
    "media.ffmpeg_heavy_max_pending": maxPending,
    "media.ffmpeg_heavy_max_wait_seconds": maxWaitSeconds,
    // 并发实测不考察按用户公平：个人名额放开到与全局一致
    "media.ffmpeg_heavy_user_max_concurrency": maxConcurrency,
    "media.ffmpeg_heavy_user_max_pending": maxPending,
  };
}

/** 同时发起 n 个 ffmpeg 任务；池的上限在首次使用时固定，因此每个场景重新加载模块 */
async function fire(n: number, signals: Array<AbortSignal | undefined> = []) {
  const { runFfmpegHeavy } = await import("@server/services/storage/ffmpeg");
  const { MediaPoolBusyError } = await import("@server/services/storage/media-pool");
  const startedAt = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => runFfmpegHeavy(JOB_ARGS, 30_000, { signal: signals[i], owner: 1 })),
  );
  const busyReasons = results.flatMap((r) =>
    r.status === "rejected" && r.reason instanceof MediaPoolBusyError ? [r.reason.reason] : [],
  );
  return {
    elapsedMs: Date.now() - startedAt,
    succeeded: results.filter((r) => r.status === "fulfilled").length,
    busyReasons,
    results,
  };
}

beforeAll(() => {
  if (!available) return;
  const startedAt = Date.now();
  spawnSync(bin, JOB_ARGS);
  jobMs = Date.now() - startedAt;
});

beforeEach(() => {
  vi.resetModules();
  live.current = 0;
  live.peak = 0;
  live.spawned = 0;
});

describe.skipIf(!available)("媒体池并发实测（真实 ffmpeg）", () => {
  it("上限 10、队列 5，同时进来 15 个：10 个运行、5 个排队等待，全部成功", async () => {
    configure(10, 5, 60);
    const { elapsedMs, succeeded, busyReasons } = await fire(15);

    expect(live.peak).toBe(10);
    expect(succeeded).toBe(15);
    expect(busyReasons).toEqual([]);
    // 分两批串行（10 + 5）：总耗时约 2 个任务时长；若 15 个全并行则只有约 1 个
    expect(elapsedMs).toBeGreaterThanOrEqual(jobMs * 2 * 0.85);
  }, 30_000);

  it("上限 10、队列 3，同时进来 15 个：10 个运行、3 个排队、2 个立即被拒绝", async () => {
    configure(10, 3, 60);
    const { succeeded, busyReasons } = await fire(15);

    expect(live.peak).toBe(10);
    expect(succeeded).toBe(13);
    expect(busyReasons).toEqual(["queue_full", "queue_full"]);
    expect(live.spawned).toBe(13);
  }, 30_000);

  it("排队超过等待时限：被拒绝且不启动 ffmpeg", async () => {
    // 等待时限取任务时长的 1/3：排队者一定在运行中的任务结束前超时
    configure(2, 4, jobMs / 3000);
    const { succeeded, busyReasons } = await fire(4);

    expect(live.peak).toBe(2);
    expect(succeeded).toBe(2);
    expect(busyReasons).toEqual(["wait_timeout", "wait_timeout"]);
    expect(live.spawned).toBe(2);
  }, 30_000);

  it("排队中途中止：立即出队、不启动 ffmpeg，不占用槽位", async () => {
    configure(1, 4, 60);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), jobMs / 3);
    const { results, succeeded } = await fire(3, [undefined, controller.signal, undefined]);

    expect(live.peak).toBe(1);
    expect(live.spawned).toBe(2);
    expect(succeeded).toBe(2);
    expect(results[1]).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
  }, 30_000);
});

/**
 * 派生产物惰性生成：命中复用、同键并发合并、引用计数中止、空产物不发布、
 * 命中检查只读、临时文件位置与清理（真实 LocalStorageBackend.put 原子落盘）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const cfg = vi.hoisted(() => ({ uploadDir: "" }));

vi.mock("@server/core/config", () => ({
  getConfig: () => ({ UPLOAD_DIR: cfg.uploadDir, FFMPEG_PATH: "ffmpeg", LOG_LEVEL: "silent", ALLOW_INSECURE_SECRETS: true }),
}));
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));
vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());

import { AbortError } from "@server/core/abort";
import { metrics } from "@server/core/metrics";
import * as mediaPool from "@server/services/storage/media-pool";
import { ArtifactSkipError, ensureArtifact } from "@server/services/storage/artifact";
import { cacheKeyOf, posterMasterKey, spriteKeyOf } from "@server/services/storage/derived-keys";
import { initStorageBackend } from "@server/services/storage/service";
import { LocalStorageBackend } from "@server/services/storage/backends/local";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";
import { resetTestSettings } from "../../helpers/settings";

let root = "";
let seq = 0;
/** 每个用例独占源键；产物键经生产构造器派生——档位由 key 推导，测试键必须是真实命名空间 */
const sourceKey = () => `1/ab/${(seq++).toString(16).padStart(64, "0")}.png`;
const nextKey = () => cacheKeyOf(sourceKey(), 480);
const abs = (key: string) => path.join(root, key);
const exists = (p: string) => fs.access(p).then(() => true, () => false);
const tmpEntries = () => fs.readdir(path.join(root, "_tmp")).catch(() => [] as string[]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function writeExisting(key: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs(key)), { recursive: true });
  await fs.writeFile(abs(key), content);
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-"));
  // 后端与工作区根都锚定隔离目录：uploadRoot() 惰性读 config，beforeAll 落定即可
  cfg.uploadDir = root;
  initStorageBackend(new LocalStorageBackend(root));
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("ensureArtifact", () => {
  it("产物不存在时生成并原子落盘，临时文件在启动清空的 _tmp 下且保留扩展名", async () => {
    const key = nextKey();
    let seenTmp = "";
    await ensureArtifact({
      key,
      produce: async (tmpPath) => {
        seenTmp = tmpPath;
        await fs.writeFile(tmpPath, "data");
      },
    });

    expect(path.dirname(seenTmp)).toBe(path.join(root, "_tmp"));
    expect(path.extname(seenTmp)).toBe(".webp");
    expect(await fs.readFile(abs(key), "utf8")).toBe("data");
    expect(await exists(seenTmp)).toBe(false);
  });

  it("产物已存在且非空时直接复用，不生成", async () => {
    const key = nextKey();
    await writeExisting(key, "cached");
    const produce = vi.fn(async () => undefined);

    await ensureArtifact({ key, produce });

    expect(produce).not.toHaveBeenCalled();
  });

  it("0 字节旧产物不算命中：命中检查只读不删除，新产物生成后原子覆盖它", async () => {
    const key = nextKey();
    await writeExisting(key, "");
    const gate = deferred<void>();
    let started = false;

    const pending = ensureArtifact({
      key,
      produce: async (tmpPath) => {
        started = true;
        await gate.promise;
        await fs.writeFile(tmpPath, "fresh");
      },
    });
    await vi.waitFor(() => expect(started).toBe(true));
    expect(await exists(abs(key))).toBe(true);

    gate.resolve();
    await pending;
    expect(await fs.readFile(abs(key), "utf8")).toBe("fresh");
  });

  it.each([
    ["写出空文件", (tmpPath: string) => fs.writeFile(tmpPath, "")],
    ["没有写出文件", async () => undefined],
  ])("生成%s按失败处理：不发布、不留临时文件，下一次请求重新生成", async (_label, produce) => {
    const key = nextKey();

    await expect(ensureArtifact({ key, produce })).rejects.toThrow(/produced no output/);
    expect(await exists(abs(key))).toBe(false);
    expect(await tmpEntries()).toEqual([]);

    await ensureArtifact({ key, produce: (tmpPath) => fs.writeFile(tmpPath, "ok") });
    expect(await fs.readFile(abs(key), "utf8")).toBe("ok");
  });

  it("同一产物的并发请求只生成一次", async () => {
    const key = nextKey();
    const gate = deferred<void>();
    const produce = vi.fn(async (tmpPath: string) => {
      await gate.promise;
      await fs.writeFile(tmpPath, "once");
    });

    const all = Promise.all([
      ensureArtifact({ key, produce }),
      ensureArtifact({ key, produce }),
      ensureArtifact({ key, produce }),
    ]);
    await vi.waitFor(() => expect(produce).toHaveBeenCalledTimes(1));
    gate.resolve();
    await all;

    expect(produce).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(abs(key), "utf8")).toBe("once");
  });

  it("发起者先中止，搭车者仍拿到产物（生成用的临时文件不依赖任何请求）", async () => {
    const key = nextKey();
    const gate = deferred<void>();
    const leader = new AbortController();
    let genSignal!: AbortSignal;
    const produce = async (tmpPath: string, signal: AbortSignal) => {
      genSignal = signal;
      await gate.promise;
      await fs.writeFile(tmpPath, "kept");
    };

    const first = ensureArtifact({ key, signal: leader.signal, produce });
    const follower = ensureArtifact({ key, produce });
    await vi.waitFor(() => expect(genSignal).toBeDefined());
    leader.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(genSignal.aborted).toBe(false);

    gate.resolve();
    await follower;
    expect(await fs.readFile(abs(key), "utf8")).toBe("kept");
  });

  it("全部等待者中止才取消生成，且不落盘、不留临时文件", async () => {
    const key = nextKey();
    const controller = new AbortController();
    let seenTmp = "";
    const produce = (tmpPath: string, signal: AbortSignal) => new Promise<void>((_, reject) => {
      seenTmp = tmpPath;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

    const pending = ensureArtifact({ key, signal: controller.signal, produce });
    await vi.waitFor(() => expect(seenTmp).not.toBe(""));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    await vi.waitFor(async () => expect(await exists(seenTmp)).toBe(false));
    expect(await exists(abs(key))).toBe(false);
  });

  it("生成失败：全体等待者共享错误、清掉临时文件、不做负缓存", async () => {
    const key = nextKey();
    const gate = deferred<void>();
    let seenTmp = "";
    const produce = async (tmpPath: string) => {
      seenTmp = tmpPath;
      await fs.writeFile(tmpPath, "partial");
      await gate.promise;
      throw new Error("boom");
    };

    const a = ensureArtifact({ key, produce });
    const b = ensureArtifact({ key, produce });
    const settled = Promise.allSettled([a, b]);
    await vi.waitFor(() => expect(seenTmp).not.toBe(""));
    gate.resolve();
    const results = await settled;

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(await exists(seenTmp)).toBe(false);
    expect(await exists(abs(key))).toBe(false);

    await ensureArtifact({ key, produce: (tmpPath) => fs.writeFile(tmpPath, "retry") });
    expect(await fs.readFile(abs(key), "utf8")).toBe("retry");
  });

  it("请求合并不占个人名额：搭车请求不触发第二次配额获取", async () => {
    resetTestSettings({ "media.ffmpeg_heavy_user_max_concurrency": 1, "media.ffmpeg_heavy_user_max_pending": 0 });
    const key = nextKey();
    const gate = deferred<void>();
    const acquireSpy = vi.spyOn(mediaPool, "acquireHeavySlot");
    const produce = async (tmpPath: string, signal: AbortSignal) => {
      const release = await mediaPool.acquireHeavySlot(1, signal);
      try {
        await gate.promise;
        await fs.writeFile(tmpPath, "kept");
      } finally {
        release();
      }
    };

    const leader = ensureArtifact({ key, produce });
    await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledTimes(1));
    const follower = ensureArtifact({ key, produce });
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.resolve();
    await Promise.all([leader, follower]);

    // 搭车者只等待同一结果，个人名额仅生成者取一次：
    // 若搭车也取名额，user_max_pending=0 的配置会让它立即 queue_full
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(abs(key), "utf8")).toBe("kept");
  });

  it("指标按结果分类：命中 / 产出 / 失败，哨兵失败记 skipped 而非 failed", async () => {
    class SkipSentinel extends ArtifactSkipError {}
    const report = vi.spyOn(metrics, "derivedArtifact");
    try {
      await expect(
        ensureArtifact({
          key: nextKey(),
          produce: async () => { throw new SkipSentinel("no static derivation"); },
        }),
      ).rejects.toBeInstanceOf(ArtifactSkipError);
      expect(report).toHaveBeenLastCalledWith("cache", "skipped");

      await expect(
        ensureArtifact({
          key: posterMasterKey(sourceKey(), 1),
          produce: async () => { throw new Error("boom"); },
        }),
      ).rejects.toThrow("boom");
      expect(report).toHaveBeenLastCalledWith("poster", "failed");

      const key = spriteKeyOf(sourceKey(), 5, 1);
      await ensureArtifact({ key, produce: (tmpPath) => fs.writeFile(tmpPath, "x") });
      expect(report).toHaveBeenLastCalledWith("sprite", "generated");

      await ensureArtifact({ key, produce: async () => undefined });
      expect(report).toHaveBeenLastCalledWith("sprite", "hit");
    } finally {
      report.mockRestore();
    }
  });

  it("媒体池过载原样向上抛出", async () => {
    const busy = new MediaPoolBusyError("sharp", "global", "queue_full");
    await expect(
      ensureArtifact({ key: nextKey(), produce: async () => { throw busy; } }),
    ).rejects.toBe(busy);
  });

  it("取消与媒体池过载不记 failed：前者不是故障，后者由 mediaBusyRejected 单点计数", async () => {
    const report = vi.spyOn(metrics, "derivedArtifact");
    try {
      await expect(
        ensureArtifact({
          key: nextKey(),
          produce: async () => { throw new AbortError("cancelled"); },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      const busy = new MediaPoolBusyError("sharp", "global", "queue_full");
      await expect(
        ensureArtifact({ key: nextKey(), produce: async () => { throw busy; } }),
      ).rejects.toBe(busy);

      expect(report).not.toHaveBeenCalled();
    } finally {
      report.mockRestore();
    }
  });

  it("非派生命名空间的 key 拒绝：档位无从推导，指标标签也没有对的答案", async () => {
    await expect(
      ensureArtifact({ key: "artifacts/x.webp", produce: async () => undefined }),
    ).rejects.toThrow(/derived namespaces/);
  });
});

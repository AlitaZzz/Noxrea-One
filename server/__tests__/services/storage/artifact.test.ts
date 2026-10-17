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

import * as mediaPool from "@server/services/storage/media-pool";
import { ensureArtifact } from "@server/services/storage/artifact";
import { initStorageBackend } from "@server/services/storage/service";
import { LocalStorageBackend } from "@server/services/storage/backends/local";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";
import { resetTestSettings } from "../../helpers/settings";

let root = "";
let seq = 0;
const nextKey = () => `_derived/artifact-${seq++}.webp`;
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

  it("媒体池过载原样向上抛出", async () => {
    const busy = new MediaPoolBusyError("sharp", "global", "queue_full");
    await expect(
      ensureArtifact({ key: nextKey(), produce: async () => { throw busy; } }),
    ).rejects.toBe(busy);
  });
});

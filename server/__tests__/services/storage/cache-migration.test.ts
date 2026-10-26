/**
 * 旧版无版本 `_cache/<tier>/` 一次性清理（specs/canvas-media-resolution-lod.md
 * 规则 8.3 /「部署与迁移」第 2 条）：本地后端与对象存储形态各覆盖一次。
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalStorageBackend } from "@server/services/storage/backends/local";
import type { StorageBackend } from "@server/services/storage/backend";
import { purgeLegacyResizeCache } from "@server/services/storage/cache-migration";

let tmpDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-cache-"));
});
afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(root: string, key: string, body = "x"): Promise<void> {
  const abs = path.join(root, key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
}

const LEGACY_KEYS = [
  "_cache/64/1/ab/one.webp",
  "_cache/1280/1/ab/two.webp",
  "_cache/200/staging/7/123e4567-e89b-12d3-a456-426614174000.webp",
];
const KEPT_KEYS = [
  "_cache/v2/64/1/ab/one.webp",
  "_cache/v2/2560/1/ab/two.webp",
  "_posters/v1/1/ab/one.webp",
  "_sprite/1/ab/one_c20v2.webp",
  "_proxy/1/ab/one_w480v3.mp4",
  "_tmp/in-flight",
  "1/ab/one.png",
];

describe("purgeLegacyResizeCache", () => {
  it("本地后端：删除旧 8 档目录，不触碰 v2/其他命名空间/源文件，重复执行幂等", async () => {
    const backend = new LocalStorageBackend(tmpDir);
    for (const key of [...LEGACY_KEYS, ...KEPT_KEYS]) await write(tmpDir, key);

    const first = await purgeLegacyResizeCache(backend);
    expect(first.scanned).toBe(LEGACY_KEYS.length);
    expect(first.deleted).toBe(LEGACY_KEYS.length);
    expect(first.failed).toEqual([]);
    expect(first.prefixes).toHaveLength(8);

    for (const key of LEGACY_KEYS) {
      await expect(fs.stat(path.join(tmpDir, key))).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const key of KEPT_KEYS) {
      await expect(fs.stat(path.join(tmpDir, key))).resolves.toBeTruthy();
    }

    const second = await purgeLegacyResizeCache(backend);
    expect(second.scanned).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.failed).toEqual([]);
  });

  it("对象存储形态：只按旧档位前缀 list/delete，删除失败记录后可重试", async () => {
    const objects = new Map<string, string>([
      ...LEGACY_KEYS.map((key) => [key, "x"] as const),
      ...KEPT_KEYS.map((key) => [key, "x"] as const),
    ]);
    const failing = new Set(["_cache/1280/1/ab/two.webp"]);
    const backend = {
      async list(prefix: string) {
        return [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key, size: 1, lastModifiedMs: 0 }));
      },
      async delete(key: string) {
        if (failing.has(key)) throw new Error("simulated delete failure");
        objects.delete(key);
      },
    } as unknown as StorageBackend;

    const first = await purgeLegacyResizeCache(backend);
    expect(first.deleted).toBe(LEGACY_KEYS.length - 1);
    expect(first.failed).toEqual([
      { key: "_cache/1280/1/ab/two.webp", error: "simulated delete failure" },
    ]);
    expect([...objects.keys()]).toEqual(expect.arrayContaining(KEPT_KEYS));
    expect(objects.has("_cache/1280/1/ab/two.webp")).toBe(true);

    failing.clear();
    const retry = await purgeLegacyResizeCache(backend);
    expect(retry.failed).toEqual([]);
    expect(objects.has("_cache/1280/1/ab/two.webp")).toBe(false);
    expect([...objects.keys()].every((key) => !key.startsWith("_cache/64/") && !key.startsWith("_cache/112/") && !key.startsWith("_cache/200/") && !key.startsWith("_cache/300/") && !key.startsWith("_cache/320/") && !key.startsWith("_cache/400/") && !key.startsWith("_cache/480/") && !key.startsWith("_cache/1280/"))).toBe(true);
  });
});

/**
 * 通用 JSON 热更新加载器。
 * 以文件 mtime 为缓存键：文件修改时间变化时才重新读取 + 解析，
 * 未变化时直接返回内存缓存，零 IO。改文件后无需重启即生效。
 *
 * 所有 resources/*.json 统一走此加载器，避免各处重复手写 mtime 缓存。
 */

import fs from "fs";
import path from "path";
import { getConfig } from "@server/core/config";
import { resolveFromRoot } from "@server/core/paths";

interface CacheEntry {
  mtime: number;
  data: unknown;
}

const cache = new Map<string, CacheEntry>();

/**
 * 加载并缓存 JSON（相对资源目录 RESOURCES_DIR 的路径）。
 *
 * 路径解析：RESOURCES_DIR（默认 server/resources，Docker 指向 /data/resources）+ relPath。
 * 改文件即生效（mtime 缓存），无需重启。
 *
 * 用法：
 *   const data = loadJson<Record<string, unknown>>("model-ui.json");
 */
export function loadJson<T>(relPath: string): T {
  const abs = resolveFromRoot(path.join(getConfig().RESOURCES_DIR, relPath));

  let mtime = 0;
  try {
    mtime = fs.statSync(abs).mtimeMs;
  } catch {
    // 文件暂不可读（未生成 / 被占用）时，返回旧缓存兜底
  }

  const hit = cache.get(abs);
  if (hit && hit.mtime === mtime) return hit.data as T;

  const raw = fs.readFileSync(abs, "utf-8");
  const data = JSON.parse(raw) as T;
  cache.set(abs, { mtime, data });
  return data;
}

/** 主动清除某文件缓存，强制下次调用重新读取（极少需要） */
export function invalidateJson(relPath: string): void {
  cache.delete(resolveFromRoot(path.join(getConfig().RESOURCES_DIR, relPath)));
}

/**
 * 通用 JSON 热更新加载器。
 * 以文件 mtime 为缓存键：文件修改时间变化时才重新读取 + 解析，
 * 未变化时直接返回内存缓存，零 IO。改文件后无需重启即生效。
 *
 * 所有 resources/*.json 统一走此加载器，避免各处重复手写 mtime 缓存。
 */

import fs from "fs";
import path from "path";
import { logger } from "@server/core/logger";
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
 * 失败语义（validate 是加载成功语义的一部分，校验失败=加载失败）：
 * - 首次加载失败（文件缺失 / JSON 非法 / 校验不通过）→ 原样抛出，启动期 fail-fast；
 * - 热更新重读失败 → 记 warn 并返回旧缓存继续服务，配置坏了不打断运行中的服务。
 * 缓存保存校验产物：validate 存在时缓存其返回值，热更失败回退的旧缓存同样是
 * 已通过校验的数据（此前校验发生在 loadJson 之外，结构坏的热更会把坏数据写入
 * 缓存并使路由持续 500，这是被验收审计判为返工项的根因）。
 *
 * 用法：
 *   const data = loadJson<Record<string, unknown>>("model-ui.json");
 *   const presets = loadJson("provider-presets.json", (d) => presetsSchema.parse(d));
 */
export function loadJson<T>(relPath: string, validate?: (data: unknown) => T): T {
  const abs = resolveFromRoot(path.join(getConfig().RESOURCES_DIR, relPath));
  const hit = cache.get(abs);

  let mtime = 0;
  try {
    mtime = fs.statSync(abs).mtimeMs;
  } catch {
    // 文件暂不可读（未生成 / 被占用）：无旧缓存时 readFileSync 会抛出，有则走旧缓存
  }

  if (hit && hit.mtime === mtime) return hit.data as T;

  try {
    const raw = fs.readFileSync(abs, "utf-8");
    const data = JSON.parse(raw);
    const result = validate ? validate(data) : (data as T);
    cache.set(abs, { mtime, data: result });
    return result;
  } catch (err) {
    if (hit) {
      logger.warn({ err, file: relPath }, "json reload failed, serving stale cache");
      return hit.data as T;
    }
    throw err;
  }
}

/** 主动清除某文件缓存，强制下次调用重新读取（极少需要） */
export function invalidateJson(relPath: string): void {
  cache.delete(resolveFromRoot(path.join(getConfig().RESOURCES_DIR, relPath)));
}

/**
 * 参考图解析。
 * 将用户传入的参考图路径或 URL 解析为可访问的资源，并做路径穿越防护。
 */

import { MANAGED_FILE_PATH, stripTrailingSlash } from "@noxrea/shared/url";
import { logEvent } from "@server/core/logger/utils";
import { getConfig } from "@server/core/config";
import { isPathWithinBase } from "@server/core/paths";
import fs from "fs/promises";
import path from "path";
import { localStorage } from "@server/services/storage/backends/local";
import { mimeByExt } from "@server/services/storage/mime";
import { GenerationFailureError } from "@server/services/tasks/failure";

/**
 * 将存储路径转为完整的 data: URL（base64）。
 * 读取自身文件并 base64 编码。
 * 读取失败或路径越界直接抛错——把损坏的本地路径原样传给上游只会得到
 * 一个必然失败的上游任务（且计费），不如在本环节就明确失败原因。
 */
async function readSelfFile(relPath: string): Promise<string> {
  const fullPath = path.resolve(localStorage.baseDir, relPath);

  // 路径穿越防护
  if (!isPathWithinBase(localStorage.baseDir, fullPath)) {
    logEvent("resolver.reference", {
      stage: "path_traversal_blocked",
      path: relPath.slice(0, 80),
    });
    throw new GenerationFailureError(
      `参考素材读取失败: ${relPath}`,
      "generation.reference_unavailable"
    );
  }

  let data: Buffer;
  try {
    data = await fs.readFile(fullPath);
  } catch (err) {
    logEvent("resolver.reference", {
      stage: "self_file_read_failed",
      path: relPath.slice(0, 80),
      error: (err as Error).message,
    });
    throw new GenerationFailureError(
      `参考素材读取失败: ${relPath}`,
      "generation.reference_unavailable"
    );
  }

  const ext = path.extname(relPath).toLowerCase();
  const mime = mimeByExt(ext);
  const b64 = data.toString("base64");
  return `data:${mime};base64,${b64}`;
}

/**
 * 参考素材通用解析（对齐 Python resolve_refs 三档策略）：
 * 1) data: URL → 直接透传
 * 2) 同源 URL（/api/files/ 或纯存储路径） → 配置 PUBLIC_URL 时拼公网 URL 透传，否则读本机磁盘转 base64 data URL
 * 3) 外链 URL → 透传原串
 * 本地素材读取失败时抛 GenerationFailureError，外链透传不涉及读取、不会失败。
 *
 * 契约：返回数组与输入严格等长同序（1:1）——任一 URL 解析失败即抛错，绝不静默跳过。
 * 消费方（如 llm 的 resolveMessageImages）依赖此契约按下标对位回写，非空断言因此成立。
 */
async function resolveRefList(urls: string[]): Promise<string[]> {
  if (!urls || urls.length === 0) return [];

  const resolved: string[] = [];

  for (const url of urls) {
    // 已经是 data: URL → 直接透传
    if (url.startsWith("data:")) {
      resolved.push(url);
      continue;
    }

    // 同源 URL（/api/files/ 或纯存储路径）：
    // 配置了 PUBLIC_URL → 拼公网 URL 透传（上游按 URL 拉取）；未配置 → 回退读盘转 base64
    if (url.startsWith(MANAGED_FILE_PATH) || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      const relPath = url.startsWith(MANAGED_FILE_PATH) ? url.slice(MANAGED_FILE_PATH.length) : url;
      const publicUrl = stripTrailingSlash(getConfig().PUBLIC_URL);
      if (publicUrl) {
        resolved.push(`${publicUrl}${MANAGED_FILE_PATH}${relPath}`);
        continue;
      }
      resolved.push(await readSelfFile(relPath));
      continue;
    }

    // 外链 → 透传
    resolved.push(url);
  }

  return resolved;
}

/** 解析参考图列表 */
export function resolveRefImages(urls: string[]): Promise<string[]> {
  return resolveRefList(urls);
}

/** 解析参考音频列表 */
export function resolveRefAudio(urls: string[]): Promise<string[]> {
  return resolveRefList(urls);
}

/** 解析参考视频列表 */
export function resolveRefVideo(urls: string[]): Promise<string[]> {
  return resolveRefList(urls);
}

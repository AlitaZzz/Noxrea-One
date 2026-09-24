/**
 * 参考图解析。
 * 将用户传入的参考图路径或 URL 解析为可访问的资源，并做路径穿越防护。
 */

import { logEvent } from "@server/core/logger/utils";
import { getConfig } from "@server/core/config";
import { isPathWithinBase } from "@server/core/paths";
import fs from "fs/promises";
import path from "path";
import { localStorage } from "@server/services/storage/backends/local";
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
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".wave": "audio/wav",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
  };
  const mime = mimeMap[ext] ?? "application/octet-stream";
  const b64 = data.toString("base64");
  return `data:${mime};base64,${b64}`;
}

/**
 * 参考素材通用解析（对齐 Python resolve_refs 三档策略）：
 * 1) data: URL → 直接透传
 * 2) 同源 URL（/api/files/ 或纯存储路径） → 配置 PUBLIC_URL 时拼公网 URL 透传，否则读本机磁盘转 base64 data URL
 * 3) 外链 URL → 透传原串
 * 本地素材读取失败时抛 GenerationFailureError，外链透传不涉及读取、不会失败。
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
    if (url.startsWith("/api/files/") || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      const relPath = url.startsWith("/api/files/") ? url.replace(/^\/api\/files\//, "") : url;
      const publicUrl = getConfig().PUBLIC_URL.replace(/\/+$/, "");
      if (publicUrl) {
        resolved.push(`${publicUrl}/api/files/${relPath}`);
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

/**
 * 参考图解析。
 * 将用户传入的参考图路径或 URL 解析为可访问的资源，并做路径穿越防护。
 */

import { logEvent } from "@server/core/logger/utils";
import { getConfig } from "@server/core/config";
import fs from "fs/promises";
import path from "path";
import { localStorage } from "@server/services/storage/backends/local";

/**
 * 路径穿越防护：校验用户文件访问是否在允许的目录内。
 */
function isPathWithin(base: string, target: string): boolean {
  const resolvedBase = path.resolve(base).replace(/\\/g, "/");
  const resolvedTarget = path.resolve(target).replace(/\\/g, "/");
  return resolvedTarget.startsWith(resolvedBase + "/") || resolvedTarget === resolvedBase;
}

/**
 * 将存储路径转为完整的 data: URL（base64）。
 * 读取自身文件并 base64 编码。
 */
async function readSelfFile(relPath: string): Promise<string | null> {
  try {
    const fullPath = path.resolve(localStorage.baseDir, relPath);

    // 路径穿越防护
    if (!isPathWithin(localStorage.baseDir, fullPath)) {
      logEvent("resolver.reference", {
        stage: "path_traversal_blocked",
        path: relPath.slice(0, 80),
      });
      return null;
    }

    const data = await fs.readFile(fullPath);
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
  } catch {
    return null;
  }
}

/**
 * 参考素材通用解析（对齐 Python resolve_refs 三档策略）：
 * 1) data: URL → 直接透传
 * 2) 同源 URL（/api/files/ 或纯存储路径） → 配置 PUBLIC_URL 时拼公网 URL 透传，否则读本机磁盘转 base64 data URL
 * 3) 外链 URL → 透传原串
 * 失败时透传原 URL。
 */
async function resolveRefList(
  urls: string[],
  userId: number,
  stage: string
): Promise<string[]> {
  if (!urls || urls.length === 0) return [];

  const resolved: string[] = [];

  for (const url of urls) {
    try {
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
        const dataUrl = await readSelfFile(relPath);
        resolved.push(dataUrl ?? url);
        continue;
      }

      // 外链 → 透传
      resolved.push(url);
    } catch (err) {
      logEvent("resolver.reference", {
        stage,
        url: url.slice(0, 80),
        error: (err as Error).message,
      });
      resolved.push(url); // 失败时透传原 URL
    }
  }

  return resolved;
}

/** 解析参考图列表 */
export async function resolveRefImages(urls: string[], userId: number): Promise<string[]> {
  return resolveRefList(urls, userId, "resolve_failed");
}

/** 解析参考音频列表 */
export async function resolveRefAudio(urls: string[], userId: number): Promise<string[]> {
  return resolveRefList(urls, userId, "resolve_audio_failed");
}

/** 解析参考视频列表 */
export async function resolveRefVideo(urls: string[], userId: number): Promise<string[]> {
  return resolveRefList(urls, userId, "resolve_video_failed");
}

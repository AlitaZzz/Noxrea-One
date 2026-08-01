// ── 参考图解析（对应 backend/app/services/resolvers/reference.py） ──

import { logEvent } from "@server/core/logger/utils";
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
 * 对应 Python read_self_file + base64 encode。
 */
async function readSelfFile(relPath: string, userId: number): Promise<string | null> {
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
    };
    const mime = mimeMap[ext] ?? "application/octet-stream";
    const b64 = data.toString("base64");
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

/**
 * 解析参考图列表（对齐 Python resolve_refs 三档策略）：
 * 1) 同源 URL → 直接读本机磁盘转 base64 data URL
 * 2) 存储路径（如 "3/35/xxx.png"） → 同源处理，转 base64
 * 3) 外链 URL → 透传原串
 */
export async function resolveRefImages(
  urls: string[],
  userId: number
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

      // /api/files/ 开头的同源 URL → 提取相对路径 → 转 base64
      if (url.startsWith("/api/files/")) {
        const relPath = url.replace(/^\/api\/files\//, "");
        const dataUrl = await readSelfFile(relPath, userId);
        if (dataUrl) {
          resolved.push(dataUrl);
          continue;
        }
        // 读盘失败，推原路径
        resolved.push(url);
        continue;
      }

      // 纯存储路径（非 HTTP、非 /api/files/）→ 转 base64
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        const dataUrl = await readSelfFile(url, userId);
        if (dataUrl) {
          resolved.push(dataUrl);
          continue;
        }
        resolved.push(url);
        continue;
      }

      // 外链 → 透传
      resolved.push(url);
    } catch (err) {
      logEvent("resolver.reference", {
        stage: "resolve_failed",
        url: url.slice(0, 80),
        error: (err as Error).message,
      });
      resolved.push(url); // 失败时透传原 URL
    }
  }

  return resolved;
}

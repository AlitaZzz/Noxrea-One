export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { getResizedWebP, validateUserFile } from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";
import { fail } from "@server/core/response";
import path from "path";
import { createReadStream } from "fs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: pathSegments } = await params;

  // 路径穿越防护
  if (pathSegments.some((seg) => seg.includes(".."))) {
    return fail(403, "Invalid path");
  }

  let filePath = pathSegments.join("/");
  const searchParams = request.nextUrl.searchParams;

  // w 缩放参数 → WebP 缓存
  const w = searchParams.get("w");
  if (w) {
    const width = parseInt(w, 10);
    if (!isNaN(width) && width > 0) {
      const cached = await getResizedWebP(filePath, width);
      if (cached) {
        filePath = cached;
      }
    }
  }

  const fullPath = path.resolve(localStorage.baseDir, filePath);

  // 路径穿越校验
  if (!validateUserFile(fullPath, localStorage.baseDir)) {
    return fail(403, "Access denied");
  }

  let stat: { size: number; mtimeMs: number } | null;
  try {
    stat = await localStorage.stat(filePath);
  } catch {
    stat = null;
  }

  if (!stat) return fail(404, "File not found");

  // Content-Type
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
  };
  const contentType = mimeMap[ext] ?? "application/octet-stream";

  // download 参数 → Content-Disposition
  const download = searchParams.get("download");
  const filename = searchParams.get("filename");
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Length": String(stat.size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  });

  if (download !== null) {
    // 确保文件名以原始扩展名结尾（对齐 Python 后端）
    const ext = path.extname(filePath);
    let baseName = filename ?? path.basename(filePath);
    if (!baseName.toLowerCase().endsWith(ext.toLowerCase())) {
      baseName += ext;
    }
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(baseName)}`);
  }

  // Range 请求支持（视频 seek 依赖）
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2]
        ? parseInt(match[2], 10)
        : stat.size - 1;

      if (start >= stat.size) {
        return new Response(null, { status: 416, headers });
      }

      const actualEnd = Math.min(end, stat.size - 1);
      const chunkSize = actualEnd - start + 1;

      const stream = createReadStream(fullPath, { start, end: actualEnd });

      headers.set("Content-Length", String(chunkSize));
      headers.set("Content-Range", `bytes ${start}-${actualEnd}/${stat.size}`);

      return new Response(stream as unknown as ReadableStream, { status: 206, headers });
    }
  }

  // 流式返回（禁止整文件读入内存）
  const stream = createReadStream(fullPath);

  return new Response(stream as unknown as ReadableStream, { headers });
}

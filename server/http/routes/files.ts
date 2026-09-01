/**
 * 文件服务路由。
 * 提供文件下载、Range 请求、WebP 缩放与流式响应等接口。
 */
import { Hono } from "hono";
import { getResizedWebP, validateUserFile } from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";
import { failCode } from "@server/core/response";
import path from "path";
import { createReadStream } from "fs";
import { Readable } from "node:stream";

const router = new Hono();

router.get("/api/files/*", async (c) => {
  const request = c.req.raw;

  // 从 URL 提取文件路径（去掉 /api/files/ 前缀）
  const url = new URL(request.url);
  const filePath = decodeURIComponent(url.pathname.replace(/^\/api\/files\//, ""));

  // 路径穿越防护
  const pathSegments = filePath.split("/");
  if (pathSegments.some((seg) => seg.includes(".."))) {
    return failCode(403, "files.invalid_path");
  }

  let resolvedPath = filePath;

  // w 缩放参数 -> WebP 缓存（仅对图片生效，视频不应走 sharp 缩放）
  const w = c.req.query("w");
  const isVideoExt = /\.(mp4|webm|mov|avi|mkv|m4v)$/i.test(filePath);
  if (w && !isVideoExt) {
    const width = parseInt(w, 10);
    if (!isNaN(width) && width > 0) {
      // 透传 signal：客户端断开时中止缩放任务，及时释放 sharp 持有的源文件句柄
      const cached = await getResizedWebP(filePath, width, request.signal);
      if (cached) {
        resolvedPath = cached;
      }
    }
  }

  const fullPath = path.resolve(localStorage.baseDir, resolvedPath);

  // 路径穿越校验
  if (!validateUserFile(fullPath, localStorage.baseDir)) {
    return failCode(403, "files.access_denied");
  }

  let stat: { size: number; mtimeMs: number } | null;
  try {
    stat = await localStorage.stat(resolvedPath);
  } catch {
    stat = null;
  }

  if (!stat) return failCode(404, "files.file_not_found");

  // Content-Type
  const ext = path.extname(resolvedPath).toLowerCase();
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
  ".flac": "audio/flac",
  };
  const contentType = mimeMap[ext] ?? "application/octet-stream";

  // download 参数 -> Content-Disposition
  const download = c.req.query("download");
  const filename = c.req.query("filename");
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Length": String(stat.size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  });

  if (download !== null) {
    const rawExt = path.extname(resolvedPath);
    let baseName = filename ?? path.basename(resolvedPath);
    if (!baseName.toLowerCase().endsWith(rawExt.toLowerCase())) {
      baseName += rawExt;
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

      // 带上 signal：视频 seek 会频繁取消 Range 请求，
      // 没有它的话流可能不被销毁，句柄悬挂，Windows 上表现为文件被锁
      const stream = Readable.toWeb(
        createReadStream(fullPath, { start, end: actualEnd, signal: request.signal }),
      );

      headers.set("Content-Length", String(chunkSize));
      headers.set("Content-Range", `bytes ${start}-${actualEnd}/${stat.size}`);

      return new Response(stream, { status: 206, headers });
    }
  }

  // 流式返回（禁止整文件读入内存）；signal 保证客户端断开时句柄被立即释放
  const stream = Readable.toWeb(createReadStream(fullPath, { signal: request.signal }));

  return new Response(stream, { headers });
});

export { router };

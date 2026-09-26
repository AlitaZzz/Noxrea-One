/**
 * 文件服务路由。
 * 提供文件下载、Range 请求、WebP 缩放与流式响应等接口。
 */
import { Hono } from "hono";
import { getResizedWebP, getVideoPosterWebP } from "@server/services/storage/resize-cache";
import { localStorage } from "@server/services/storage/backends/local";
import { failCode } from "@server/core/response";
import path from "path";
import { createReadStream } from "fs";
import { Readable } from "node:stream";
import { buildFileResponseHeaders } from "@server/http/file-response";
import { isPathWithinBase } from "@server/core/paths";

const router = new Hono();

router.get("/api/files/*", async (c) => {
  const request = c.req.raw;

  // 从 URL 提取文件路径（去掉 /api/files/ 前缀）；
  // 畸形百分号编码（如 /api/files/%zz）按客户端错误回 400，而非未捕获 URIError 变 500
  const url = new URL(request.url);
  let filePath: string;
  try {
    filePath = decodeURIComponent(url.pathname.replace(/^\/api\/files\//, ""));
  } catch {
    return failCode(400, "common.invalid_request");
  }

  // 路径穿越防护
  const pathSegments = filePath.split("/");
  if (pathSegments.some((seg) => seg.includes(".."))) {
    return failCode(403, "files.invalid_path");
  }

  let resolvedPath = filePath;

  // w 缩放参数 -> WebP 缓存：
  // 图片走 sharp 缩放；视频走 ffmpeg 抽帧缩放（首帧），按需惰性生成并缓存。
  const w = c.req.query("w");
  const isVideoExt = /\.(mp4|webm|mov|avi|mkv|m4v)$/i.test(filePath);
  if (w) {
    const width = parseInt(w, 10);
    if (!isNaN(width) && width > 0) {
      // 透传 signal：客户端断开时中止缩放任务，及时释放源文件句柄
      const cached = isVideoExt
        ? await getVideoPosterWebP(filePath, width, request.signal)
        : await getResizedWebP(filePath, width, request.signal);
      if (cached) {
        resolvedPath = cached;
      } else if (isVideoExt) {
        // 视频缩略图生成失败：不回退原视频（否则 <img> 解码失败），返回 404 由前端兜底
        return failCode(404, "files.file_not_found");
      }
    }
  }

  const fullPath = path.resolve(localStorage.baseDir, resolvedPath);

  // 路径穿越校验
  if (!isPathWithinBase(localStorage.baseDir, fullPath)) {
    return failCode(403, "files.access_denied");
  }

  let stat: { size: number; mtimeMs: number } | null;
  try {
    stat = await localStorage.stat(resolvedPath);
  } catch {
    stat = null;
  }

  if (!stat) return failCode(404, "files.file_not_found");

  const ext = path.extname(resolvedPath).toLowerCase();

  // download 参数 -> Content-Disposition
  const download = c.req.query("download");
  const filename = c.req.query("filename");
  const headers = buildFileResponseHeaders(ext, stat.size);

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

      if (start >= stat.size || end < start) {
        // 416 附带 Content-Range: bytes */size（RFC 9110），便于客户端探测真实大小
        const failHeaders = new Headers(headers);
        failHeaders.delete("Content-Length");
        failHeaders.set("Content-Range", `bytes */${stat.size}`);
        return new Response(null, { status: 416, headers: failHeaders });
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

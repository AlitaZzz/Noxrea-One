/**
 * 文件服务路由。
 * 提供文件下载、Range 请求、WebP 缩放与流式响应等接口。
 */
import { Hono } from "hono";
import { getResizedWebP, getVideoPosterWebP } from "@server/services/storage/resize-cache";
import { StorageTraversalError } from "@server/services/storage/backend";
import { getStorageBackend } from "@server/services/storage/service";
import { failCode } from "@server/core/response";
import { getSetting } from "@server/core/settings";
import { authenticateRequest } from "@server/http/middleware/auth";
import { verifyFileUrlSignature } from "@server/services/storage/file-url-signature";
import path from "path";
import { Readable } from "node:stream";
import { attachmentDisposition, buildFileResponseHeaders } from "@server/http/file-response";
import { isVideoExt } from "@server/services/storage/formats";
import { extOfName } from "@server/services/storage/mime";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";
import { failMediaBusy } from "@server/http/media-busy";

const router = new Hono();

router.get("/api/files/*", async (c) => {
  const request = c.req.raw;

  // 从 URL 提取存储 key（去掉 /api/files/ 前缀）；
  // 畸形百分号编码（如 /api/files/%zz）按客户端错误回 400，而非未捕获 URIError 变 500
  const url = new URL(request.url);
  let requestedKey: string;
  try {
    requestedKey = decodeURIComponent(url.pathname.replace(/^\/api\/files\//, ""));
  } catch {
    return failCode(400, "common.invalid_request");
  }

  // 双凭据（spec 规则 6）：浏览器会话（cookie/Bearer）或与 key 绑定的
  // 应用层签名 URL 二者其一；无会话的上游消费方（AI 拉取、脚本）走
  // 签名凭据，两类凭据互不影响。鉴权先于派生缓存（重型工作）执行
  const auth = await authenticateRequest(request);
  if (
    "error" in auth &&
    !verifyFileUrlSignature(requestedKey, url.searchParams.get("expires"), url.searchParams.get("signature"))
  ) {
    return auth.error;
  }

  // 路径穿越防护（鉴权之后：key 形态的 403 信息只暴露给通过凭据校验的调用方）
  const pathSegments = requestedKey.split("/");
  if (pathSegments.some((seg) => seg.includes(".."))) {
    return failCode(403, "files.invalid_path");
  }

  let objectKey = requestedKey;

  // w 缩放参数 -> WebP 缓存：
  // 图片走 sharp 缩放；视频走 ffmpeg 抽帧缩放（首帧），按需惰性生成并缓存。
  const w = c.req.query("w");
  if (w) {
    const width = parseInt(w, 10);
    if (!isNaN(width) && width > 0) {
      // 透传 signal：客户端断开时中止缩放任务，及时释放源文件句柄
      const video = isVideoExt(extOfName(requestedKey));
      try {
        const cached = video
          ? await getVideoPosterWebP(requestedKey, width, request.signal)
          : await getResizedWebP(requestedKey, width, request.signal);
        if (cached) {
          objectKey = cached;
        } else if (video) {
          // 视频缩略图生成失败：不回退原视频（否则 <img> 解码失败），返回 404 由前端兜底
          return failCode(404, "files.file_not_found");
        }
      } catch (err: unknown) {
        // 媒体池过载：全局阶段 503 media.busy，个人阶段 429 media.user_busy；不回退原图（原图上限 100MB，回退会把 CPU 过载变成带宽洪峰）
        if (err instanceof MediaPoolBusyError) return failMediaBusy(err.pool, err.scope);
        throw err;
      }
    }
  }

  // 存在性与穿越校验：后端解析 key 时逃出命名空间抛 StorageTraversalError（403），
  // key 不存在（含缩放缓存未生成）返回 null（404）
  const backend = getStorageBackend();
  let stat: { size: number; mtimeMs: number } | null;
  try {
    stat = await backend.stat(objectKey);
  } catch (err: unknown) {
    if (err instanceof StorageTraversalError) {
      return failCode(403, "files.access_denied");
    }
    throw err;
  }

  if (!stat) return failCode(404, "files.file_not_found");

  const ext = extOfName(objectKey);

  // download 参数 -> Content-Disposition
  const download = c.req.query("download");
  const filename = c.req.query("filename");
  const headers = buildFileResponseHeaders(ext, stat.size);

  // 下载名：filename 参数优先，缺扩展名时补上（redirect 分发的 disposition 同名）
  let baseName = filename ?? path.basename(objectKey);
  if (!baseName.toLowerCase().endsWith(ext)) {
    baseName += ext;
  }
  if (download !== null) {
    headers.set("Content-Disposition", attachmentDisposition(baseName));
  }

  // 读取分发（spec 规则 4/5）：具备预签名能力且 delivery=redirect 时 302 到
  // 预签名 GET——字节不经过应用服务器，Range 由浏览器直接向对象存储发起
  // （原生 206）；proxy 模式与 local 后端走下方流式转发。预签名的签名时间
  // 对齐 TTL/4 的 epoch 窗口，配合 immutable 缓存控制命中浏览器缓存
  if (backend.presignGet && getSetting("storage.s3.delivery") === "redirect") {
    const ttl = getSetting("storage.s3.signed_url_ttl_seconds");
    const target = await backend.presignGet(objectKey, {
      ttlSeconds: ttl,
      ...(download !== null ? { responseContentDisposition: attachmentDisposition(baseName) } : {}),
      cacheControl: `public, max-age=${ttl}, immutable`,
    });
    return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
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
        await backend.get(objectKey, {
          range: { start, end: actualEnd },
          signal: request.signal,
        }),
      );

      headers.set("Content-Length", String(chunkSize));
      headers.set("Content-Range", `bytes ${start}-${actualEnd}/${stat.size}`);

      return new Response(stream, { status: 206, headers });
    }
  }

  // 流式返回（禁止整文件读入内存）；signal 保证客户端断开时句柄被立即释放
  const stream = Readable.toWeb(await backend.get(objectKey, { signal: request.signal }));

  return new Response(stream, { headers });
});

export { router };

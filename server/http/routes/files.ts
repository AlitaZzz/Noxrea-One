/**
 * 文件服务路由。
 *
 * GET  /api/files/*       —— 字节路径：流式返回、Range、按需派生图（local 流式与能力凭据）
 * POST /api/files/access  —— 访问描述（批量）：会话鉴权后逐条返回签名直连 URL 或应用流式 URL
 *
 * 浏览器读路径的工作由描述接口承担（specs/storage-signed-direct-delivery.md）：
 * 应用只做鉴权、派生与签址，字节由浏览器直连对象存储；GET 不再 302。
 * 读管线（归属、穿越、派生、stat）抽在 `server/http/file-read.ts`，两条路由共用。
 */
import { Hono } from "hono";
import { Readable } from "node:stream";

import { buildManagedFileQueryUrl } from "@noxrea/shared/url";
import { logEvent } from "@server/core/logger/utils";
import { metrics } from "@server/core/metrics";
import { failCode, ok } from "@server/core/response";
import { requireSessionRead, resolveByteReadCredential } from "@server/http/file-read-auth";
import {
  attachmentDisposition,
  buildFileResponseHeaders,
  type FileCachePolicy,
} from "@server/http/file-response";
import {
  downloadBaseName,
  prepareFileRead,
  readFailureCode,
  readFailureResponse,
} from "@server/http/file-read";
import {
  fileAccessRequestSchema,
  type FileAccessItem,
} from "@server/schemas/file-access";
import { type SignedReadBackend, supportsSignedRead } from "@server/services/storage/backend";
import { getStorageBackend } from "@server/services/storage/service";
import {
  PRESIGNED_READ_TTL_SECONDS,
  PRESIGNED_READ_WINDOW_SECONDS,
  presignedCacheControl,
  presignedWindow,
} from "@server/services/storage/signing";

const router = new Hono();

/**
 * 批内并发上限（spec 规则 2.8）：50 条描述共享 6 个席位，单个批量请求
 * 不会把媒体池（sharp/ffmpeg 名额）一次性打满。
 */
const FILE_ACCESS_CONCURRENCY = 6;

/**
 * 有界并发的保序映射：结果下标与输入一致（描述响应必须同序、同长）。
 * 生产者每取一项即递增游标，工作协程数不超过 `limit`。
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** 描述响应的一条：成功带 `url`，失败只带错误码（前端按 i18n 展示） */
type DescribedItem =
  | { key: string; url: string; delivery: "signed"; expiresAt: number; refreshAt: number }
  | { key: string; url: string; delivery: "stream" }
  | { key: string; error: string };

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

  // 凭据判定先于 key 形态判定：能力签名锚定 key，且 key 形态的 403 只对已授权调用方可见
  const credential = await resolveByteReadCredential(request, requestedKey);
  if (!credential.ok) return credential.sessionErrorResponse;

  const w = c.req.query("w");
  const parsedWidth = w ? parseInt(w, 10) : NaN;
  const width = Number.isNaN(parsedWidth) || parsedWidth <= 0 ? undefined : parsedWidth;

  const prepared = await prepareFileRead(requestedKey, width, request.signal, credential);
  if (!prepared.ok) return readFailureResponse(prepared.failure);
  const read = prepared.read;

  // 缓存语义按凭据类型：会话/流式 private；能力凭据寿命封顶到签名剩余有效期。
  const cache: FileCachePolicy =
    credential.credential === "capability"
      ? {
          credential: "capability",
          maxAgeSeconds: credential.expiresAt - Math.floor(Date.now() / 1000),
        }
      : { credential: "session" };

  const headers = buildFileResponseHeaders(read.ext, read.stat.size, cache);

  if (c.req.query("download") !== undefined) {
    const baseName = downloadBaseName(
      c.req.query("filename") ?? undefined,
      read.requestedKey,
      read.ext,
    );
    headers.set("Content-Disposition", attachmentDisposition(baseName));
  }

  const backend = getStorageBackend();

  // Range 请求支持（视频 seek 依赖）
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2]
        ? parseInt(match[2], 10)
        : read.stat.size - 1;

      if (start >= read.stat.size || end < start) {
        // 416 附带 Content-Range: bytes */size（RFC 9110），便于客户端探测真实大小
        const failHeaders = new Headers(headers);
        failHeaders.delete("Content-Length");
        failHeaders.set("Content-Range", `bytes */${read.stat.size}`);
        failHeaders.set("Cache-Control", "no-store");
        return new Response(null, { status: 416, headers: failHeaders });
      }

      const actualEnd = Math.min(end, read.stat.size - 1);
      const chunkSize = actualEnd - start + 1;

      // 带上 signal：视频 seek 会频繁取消 Range 请求，
      // 没有它的话流可能不被销毁，句柄悬挂，Windows 上表现为文件被锁
      const stream = Readable.toWeb(
        await backend.get(read.objectKey, {
          range: { start, end: actualEnd },
          signal: request.signal,
        }),
      );

      headers.set("Content-Length", String(chunkSize));
      headers.set("Content-Range", `bytes ${start}-${actualEnd}/${read.stat.size}`);

      return new Response(stream, { status: 206, headers });
    }
  }

  // 流式返回（禁止整文件读入内存）；signal 保证客户端断开时句柄被立即释放
  const stream = Readable.toWeb(
    await backend.get(read.objectKey, { signal: request.signal }),
  );

  return new Response(stream, { headers });
});

/**
 * 单条描述的交付决策：形态与下载语义（一条描述的固定输入）。
 *
 * 形态与签址后端用判别联合绑在一起：`signed` 形态必然带着可签址的后端，`stream`
 * 形态必然没有。用「形态字段 + 可空后端」表达会允许「signed 却无后端」这种无法
 * 执行的状态，读代码时还得反推两个字段的补集关系。
 */
type ReadDeliveryDecision =
  | { delivery: "signed"; signed: SignedReadBackend; wantsDownload: boolean }
  | { delivery: "stream"; wantsDownload: boolean };

/**
 * 单条描述：鉴权已由调用方整批完成，这里只走读管线与签址。
 * 失败一律落到条目 `error`，整批仍返回 200（规则 2.3 / 2.4）。
 *
 * 逐条隔离（规则 2.1「不是全有或全无」）：管线内部的意外故障（存储读数失败等）
 * 必须收敛成该条的错误码，不能让一条的异常把整批打回 500。
 */
async function describeItem(
  request: Request,
  item: FileAccessItem,
  userId: number,
): Promise<DescribedItem> {
  // 形态判定属于逐条管线的一部分：后端解析失败等异常同样只能收敛到该条，
  // 不能因为它在 try 之外而把整批打回 500。
  let decision: ReadDeliveryDecision | undefined;
  try {
    decision = deliveryDecisionOf(item);
    return await describeRead(request, item, userId, decision);
  } catch (err: unknown) {
    // 判定失败时没有可签址后端，形态只能落在应用流一侧；指标标签集固定为
    // signed/stream，日志保留原始错误，便于与「本来就走 stream」区分。
    const delivery = decision?.delivery ?? "stream";
    logEvent("files", {
      level: "error",
      stage: "describe_failed",
      key: item.key.slice(0, 80),
      delivery,
      error: err instanceof Error ? err.message : String(err),
    });
    metrics.fileAccessDescribe(delivery, "error");
    return { key: item.key, error: "files.read_failed" };
  }
}

/** 交付形态由「后端类型 + 能力位」决定（specs/storage-provider-portability.md 规则 4.3） */
function deliveryDecisionOf(item: FileAccessItem): ReadDeliveryDecision {
  const backend = getStorageBackend();
  const wantsDownload = item.download === true;
  // 不能签 URL，或端点不遵守 `response-*` 覆盖而本次要一次性附件名（下载）时，走应用流
  if (supportsSignedRead(backend) && (!wantsDownload || backend.capabilities().responseOverrides)) {
    return { delivery: "signed", signed: backend, wantsDownload };
  }
  // 形态先定、后走管线：失败条目也要按「本来会走哪种形态」计数
  return { delivery: "stream", wantsDownload };
}

async function describeRead(
  request: Request,
  item: FileAccessItem,
  userId: number,
  decision: ReadDeliveryDecision,
): Promise<DescribedItem> {
  const { delivery, wantsDownload } = decision;
  const prepared = await prepareFileRead(item.key, item.width, request.signal, {
    ok: true,
    credential: "session",
    userId,
  });
  if (!prepared.ok) {
    metrics.fileAccessDescribe(delivery, "error");
    return { key: item.key, error: readFailureCode(prepared.failure) };
  }
  const read = prepared.read;

  const baseName = wantsDownload
    ? downloadBaseName(item.filename, read.requestedKey, read.ext)
    : undefined;

  if (decision.delivery === "stream") {
    // 应用流形态：返回带查询参数的 URL，由 GET 路由重新走同一管线取字节。
    // 查询参数构造与前端 stream 形态共用 shared 单一实现（参数顺序与转义必须一致）。
    metrics.fileAccessDescribe("stream", "ok");
    return {
      key: item.key,
      url: buildManagedFileQueryUrl(item.key, {
        // 派生 key 忽略 `w`（与 GET 管线一致）：流式 URL 必须表达实际生效的宽度
        width: read.width,
        download: wantsDownload,
        filename: baseName,
      }),
      delivery: "stream",
    };
  }

  // 先算窗口再签约：窗口若在两次调用之间翻页，签出的 URL 属于更晚的窗口，
  // 实际失效时刻晚于这里报告的 `expiresAt`——客户端提前刷新，是安全侧的偏差
  // （反序会让客户端持有一个已经死掉的地址）
  const window = presignedWindow(PRESIGNED_READ_TTL_SECONDS, PRESIGNED_READ_WINDOW_SECONDS);
  let url: string;
  try {
    url = await decision.signed.presignGet(read.objectKey, {
      ttlSeconds: PRESIGNED_READ_TTL_SECONDS,
      windowSeconds: PRESIGNED_READ_WINDOW_SECONDS,
      ...(baseName ? { responseContentDisposition: attachmentDisposition(baseName) } : {}),
      cacheControl: wantsDownload ? "private, no-store" : presignedCacheControl(window),
    });
  } catch (err: unknown) {
    logEvent("files", {
      level: "error",
      stage: "signing_failed",
      key: read.objectKey.slice(0, 80),
      error: err instanceof Error ? err.message : String(err),
    });
    metrics.presign("failed");
    metrics.fileAccessDescribe("signed", "error");
    return { key: item.key, error: "files.signing_failed" };
  }
  metrics.presign("ok");
  metrics.fileAccessDescribe("signed", "ok");

  return {
    key: item.key,
    url,
    delivery: "signed",
    expiresAt: window.expiresAt,
    refreshAt: window.refreshAt,
  };
}

router.post("/api/files/access", async (c) => {
  const request = c.req.raw;

  // 整批一次会话判定（规则 2.5）：无会话即 401，不进入逐条管线
  const credential = await requireSessionRead(request);
  if (!credential.ok) return credential.sessionErrorResponse;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  // key 的类型与长度是请求体契约（400）；键域合法性属于读管线（逐条 404），
  // 两者分开：前者是客户端错误，后者与「对象不存在」同响应
  const parsed = fileAccessRequestSchema.safeParse(body);
  if (!parsed.success) return failCode(400, "common.invalid_request");

  // 描述响应 no-store、不泄漏 referrer（规则 5.4 / 5.6）：URL 只在响应体内，不进任何缓存
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");

  metrics.fileAccessBatchSize(parsed.data.items.length);
  const items = await mapBounded(parsed.data.items, FILE_ACCESS_CONCURRENCY, (item) =>
    describeItem(request, item, credential.userId),
  );

  return c.json(ok({ items }));
});

export { router };

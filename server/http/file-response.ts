/**
 * 文件响应头契约。
 *
 * `/api/files/*` 需要读凭据：会话 Cookie，或无会话时的能力签名参数（上游经
 * network.public_base_url 携带签名直接读取）。SVG 可包含脚本，因此无论凭据类型
 * 都必须以独立的安全响应头隔离直接导航场景。
 */
import { mimeByExt } from "@server/services/storage/mime";
import { wellFormedUtf16 } from "@noxrea/shared/text";

/**
 * Content-Disposition 的 RFC 5987 下载形态（`?download` 流式响应与描述接口的预签名下载共用单一来源）。
 * 文件名来自客户端（`?filename=` / 描述请求体），可能含孤立代理；`encodeURIComponent`
 * 对孤立代理抛 URIError，必须先在编码边界归一为 well-formed。
 */
export function attachmentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(wellFormedUtf16(filename))}`;
}

/**
 * 文件响应的缓存语义（specs/storage-signed-direct-delivery.md 规则 6.2）：
 * - 会话/流式：`private`（浏览器私有缓存），不再存在共享缓存分支；
 * - 能力凭据（应用层签名 URL）：`public`，寿命封顶到签名剩余有效期；
 * - 文件响应永不输出 `Vary: Cookie` / `Set-Cookie`；
 * - 一律带 `Referrer-Policy: no-referrer`（spec 规则 5.6）：签名 URL 与带
 *   `?expires&signature` 的应用 URL 都不得以 `Referer` 形式外泄到第三方。
 */
export type FileCachePolicy =
  | { credential: "session" }
  | { credential: "capability"; maxAgeSeconds: number };

export function buildFileResponseHeaders(ext: string, size: number, cache: FileCachePolicy): Headers {
  const contentType = mimeByExt(ext);
  const cacheControl =
    cache.credential === "capability"
      ? `public, max-age=${Math.max(1, Math.floor(cache.maxAgeSeconds))}, immutable`
      : "private, max-age=31536000, immutable";
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Length": String(size),
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    "Referrer-Policy": "no-referrer",
  });

  if (ext === ".svg") {
    // sandbox 阻止直接打开 SVG 时的脚本执行与同源能力；
    // nosniff 防止浏览器把 image/svg+xml 猜测成可执行类型。
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox",
    );
    headers.set("X-Content-Type-Options", "nosniff");
  }

  return headers;
}

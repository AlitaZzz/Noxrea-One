/**
 * 文件响应头契约。
 *
 * `/api/files/*` 保持公开访问（上游通过 PUBLIC_URL 直接读取），
 * 但 SVG 可包含脚本，必须以独立的安全响应头隔离直接导航场景。
 */
import { mimeByExt } from "@server/services/storage/mime";

export function buildFileResponseHeaders(ext: string, size: number): Headers {
  const contentType = mimeByExt(ext);
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Length": String(size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
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

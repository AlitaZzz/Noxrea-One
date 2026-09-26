/**
 * 文件响应头契约。
 *
 * `/api/files/*` 保持公开访问（上游通过 PUBLIC_URL 直接读取），
 * 但 SVG 可包含脚本，必须以独立的安全响应头隔离直接导航场景。
 */
const FILE_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
};

export function buildFileResponseHeaders(ext: string, size: number): Headers {
  const contentType = FILE_MIME_BY_EXT[ext] ?? "application/octet-stream";
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

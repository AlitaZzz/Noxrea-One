/**
 * 从画布数据中提取文件 hash 列表。
 * 镜像前端 save-manager.ts 的 _collectCanvasHashes 逻辑。
 */

interface CanvasNode {
  data?: Record<string, unknown>;
}

interface ImageRef {
  url?: unknown;
}

/** 从 /api/files/{userId}/{hash[:2]}/{hash}{ext} URL 中提取 64 位 hash */
export function extractHashFromUrl(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  const idx = url.indexOf("/api/files/");
  if (idx === -1) return null;
  const path = url.slice(idx + "/api/files/".length);
  const parts = path.split("/");
  if (parts.length !== 3) return null;
  const fn = parts[2];
  const dot = fn.lastIndexOf(".");
  const h = dot > 0 ? fn.slice(0, dot) : fn;
  return h.length === 64 ? h : null;
}

/** 从画布节点数组中提取所有文件 hash（去重排序） */
export function extractHashesFromCanvas(canvasData: Record<string, unknown>): string[] {
  const nodes = (canvasData?.nodes as ReadonlyArray<CanvasNode>) ?? [];
  const hashes: string[] = [];
  for (const node of nodes) {
    const d = node?.data ?? {};
    // image-node / video-node: data.src
    if (typeof d.src === "string") {
      const h = extractHashFromUrl(d.src);
      if (h) hashes.push(h);
    }
    if (Array.isArray(d.images)) {
      for (const img of d.images as ImageRef[]) {
        if (typeof img?.url === "string") {
          const h = extractHashFromUrl(img.url);
          if (h) hashes.push(h);
        }
      }
    }
  }
  return [...new Set(hashes)].sort();
}

/**
 * 从画布数据中提取文件 hash 列表。
 * 镜像前端 save-manager.ts 的 _collectCanvasHashes 逻辑。
 */

interface CanvasNode {
  data?: Record<string, unknown>;
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

/**
 * 从存储 key 中提取 64 位 hash。
 * 存储 key 格式为 {userId}/{hash[:2]}/{hash}{ext}，
 * generation_tasks 等表落库的是这种形式（而非 /api/files/ 开头的 URL）。
 */
export function extractHashFromStorageKey(key: string): string | null {
  if (!key || typeof key !== "string") return null;
  const parts = key.split("/");
  if (parts.length !== 3) return null;
  const fn = parts[2];
  const dot = fn.lastIndexOf(".");
  const h = dot > 0 ? fn.slice(0, dot) : fn;
  return h.length === 64 ? h : null;
}

/** 从文件 URL 或存储 key 中提取 hash（两种落库格式都兼容） */
export function extractHashFromUrlOrKey(value: string): string | null {
  return extractHashFromUrl(value) ?? extractHashFromStorageKey(value);
}

/**
 * 从画布节点数组提取文件 hash 数量。
 * 计数粒度是节点：同一节点内的同一文件只计一次，不同节点分别累加。
 */
export function extractHashCountsFromCanvas(
  canvasData: Record<string, unknown>,
): Map<string, number> {
  const nodes = (canvasData?.nodes as ReadonlyArray<CanvasNode>) ?? [];
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const d = node?.data ?? {};
    // image-node / video-node：data.src 是当前节点唯一的主媒体引用。
    if (typeof d.src === "string") {
      const h = extractHashFromUrl(d.src);
      if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
    }
  }
  return counts;
}

/** 从画布节点数组中提取去重后的文件 hash（排序后返回，便于测试和展示）。 */
export function extractHashesFromCanvas(canvasData: Record<string, unknown>): string[] {
  return [...extractHashCountsFromCanvas(canvasData).keys()].sort();
}

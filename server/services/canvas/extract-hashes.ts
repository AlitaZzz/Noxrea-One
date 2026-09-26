/**
 * 从画布数据中提取文件 hash 列表。
 * 保存链路的唯一实现：服务端在 updateProject 内比较新旧画布引用，
 * 决定是否重算 file_refs 账本（前端不再参与该判定）。
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
/** 两份引用计数是否一致；一致时保存无需重算账本（布局保存不触发账本写入）。 */
export function hashCountsEqual(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [hash, count] of a) {
    if (b.get(hash) !== count) return false;
  }
  return true;
}

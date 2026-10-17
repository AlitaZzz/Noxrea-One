/**
 * 托管文件引用的 hash 提取（保存链路的唯一实现）。
 * 服务端在 updateProject 保存事务中比较新旧画布引用，决定是否重算 file_refs 账本；
 * 资产 CRUD 经同一实现从引用值中定位 file_objects 行。
 *
 * 引用值域 = 存储 key（`{userId}/{hash[:2]}/{hash}{ext}`，严格形态与 hash 提取单点在
 * shared/url.ts）或外部 http(s) URL。托管文件引用入库后一律为 key 形态
 * （specs/storage-reference-key-unification 入库值域规则）；外部 URL 不入引用账本。
 */

import { hashFromStorageKey } from "@noxrea/shared/url";

interface CanvasNode {
  data?: Record<string, unknown>;
}

/**
 * 从画布节点数组提取文件 hash 数量。
 * 计数粒度是节点：同一节点内的同一文件只计一次，不同节点分别累加。
 * image-node / video-node：data.src 是当前节点唯一的主媒体引用。
 */
export function extractHashCountsFromCanvas(
  canvasData: Record<string, unknown>,
): Map<string, number> {
  const nodes = (canvasData?.nodes as ReadonlyArray<CanvasNode>) ?? [];
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const d = node?.data;
    if (typeof d?.src === "string") {
      const h = hashFromStorageKey(d.src);
      if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
    }
  }
  return counts;
}

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

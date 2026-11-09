/**
 * 画布摘要共用的首图提取。
 * 只认第一个带非空 `data.src` 的 `image-node`；封面 key 的优先级由调用方应用。
 */
export function firstImageSrc(nodes: readonly unknown[]): string | undefined {
  for (const node of nodes) {
    if ((node as { type?: unknown } | undefined)?.type !== "image-node") continue;
    const src = (node as { data?: { src?: unknown } } | undefined)?.data?.src;
    if (typeof src === "string" && src) return src;
  }
  return undefined;
}

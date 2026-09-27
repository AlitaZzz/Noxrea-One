/**
 * 项目列表摘要投影。
 * 列表 UI 只需要 id / name / revision / updatedAt / 节点数 / 封面。
 * 节点数与首图 src 在保存路径派生进冗余列（node_count / thumbnail_src），
 * 列表查询不再读取全量 canvasData（读放大根治；单项目 GET /:id 保持全量语义）。
 */

interface SummaryNode {
  type?: unknown;
  data?: { src?: unknown } | Record<string, unknown> | undefined;
}

export interface ProjectSummaryRow {
  id: string;
  name: string;
  revision: number;
  updatedAt: Date;
  coverUrl: string | null;
  /** 保存时由画布 JSON 派生的冗余摘要列 */
  nodeCount: number;
  thumbnailSrc: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: Date;
  /** 封面：用户自定义 coverUrl 优先，否则首个带 src 的 image-node 的 src；两者皆无为 null */
  thumbnail: string | null;
  /** 封面文件 URL（未设置为 null），改封面入口据此判断是否已有自定义封面 */
  coverUrl: string | null;
  /** 节点总数（与画布 store 的节点计数语义一致） */
  nodeCount: number;
}

/** 首个带 src 的 image-node 的 src（与封面无关；coverUrl 优先级在读取时应用） */
function pickFirstImageSrc(nodes: SummaryNode[]): string | null {
  for (const node of nodes) {
    if (node?.type === "image-node") {
      const src = (node.data as { src?: unknown } | undefined)?.src;
      if (typeof src === "string" && src) return src;
    }
  }
  return null;
}

/**
 * 保存路径的冗余摘要派生：画布 JSON 在保存事务中本就要解析（hash 提取），
 * 此处复用已解析对象、零额外解析。脏数据（nodes 缺失 / 非数组）降级为空摘要，
 * 与读取端历史降级语义一致。
 */
export function deriveCanvasSummary(canvasData: unknown): {
  nodeCount: number;
  thumbnailSrc: string | null;
} {
  const nodes = (canvasData as { nodes?: unknown } | null | undefined)?.nodes;
  if (!Array.isArray(nodes)) return { nodeCount: 0, thumbnailSrc: null };
  return { nodeCount: nodes.length, thumbnailSrc: pickFirstImageSrc(nodes as SummaryNode[]) };
}

/** 冗余摘要行 → 列表摘要（缩略图 = 自定义封面优先，否则画布首图 src） */
export function toProjectSummary(row: ProjectSummaryRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    updatedAt: row.updatedAt,
    thumbnail: row.coverUrl ?? row.thumbnailSrc,
    coverUrl: row.coverUrl,
    nodeCount: row.nodeCount,
  };
}

/**
 * 项目列表摘要投影。
 * 列表 UI 只需要 id / name / revision / updatedAt / 节点数 / 封面，
 * 全量 canvasData 由列表接口在这里剥掉（单项目 GET /:id 保持全量语义）。
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
  canvasData: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: Date;
  /** 封面：用户自定义 coverUrl 优先，否则首个 image-node 的 src；两者皆无为 null */
  thumbnail: string | null;
  /** 封面文件 URL（未设置为 null），改封面入口据此判断是否已有自定义封面 */
  coverUrl: string | null;
  /** 节点总数（与画布 store 的节点计数语义一致） */
  nodeCount: number;
}

/** 列表卡片缩略图：自定义封面优先，否则首个带 src 的 image-node */
function pickThumbnail(coverUrl: string | null, nodes: SummaryNode[]): string | null {
  if (coverUrl) return coverUrl;
  for (const node of nodes) {
    if (node?.type === "image-node") {
      const src = (node.data as { src?: unknown } | undefined)?.src;
      if (typeof src === "string" && src) return src;
    }
  }
  return null;
}

/** canvasData JSON 文本 → 列表摘要（解析失败按空画布处理，列表不应因脏数据整体失败） */
export function toProjectSummary(row: ProjectSummaryRow): ProjectSummary {
  let nodes: SummaryNode[] = [];
  try {
    const parsed = JSON.parse(row.canvasData) as { nodes?: SummaryNode[] };
    if (Array.isArray(parsed?.nodes)) nodes = parsed.nodes;
  } catch {
    // 单个项目 canvasData 损坏：降级为空摘要，不阻断整个列表
  }
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    updatedAt: row.updatedAt,
    thumbnail: pickThumbnail(row.coverUrl, nodes),
    coverUrl: row.coverUrl,
    nodeCount: nodes.length,
  };
}

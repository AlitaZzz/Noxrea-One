/**
 * 项目摘要投影的唯一实现。
 *
 * 服务端列表、创建接口详情与画布会话详情形状不同，但落到 `ProjectSummary`
 * 的字段规则只有一套：revision 缺省 1、缩略图按「服务端展示缩略图 → 封面 key →
 * 详情缩略图」取首个可用值、nodeCount 缺省 0。调用方只负责把自己的来源
 * 归一到本函数的入参，不再各自重写投影。
 */
import { toTimestamp } from "@noxrea/shared/time";

import type { ProjectSummary } from "./types";

export interface ProjectSummarySource {
  id: string;
  name: string;
  revision?: number;
  /** 服务端时间为 ISO 字符串；画布会话内已归一为毫秒时间戳 */
  updatedAt?: string | number;
  /** 服务端列表的展示缩略图（封面或内容首图，由服务端计算） */
  thumbnail?: string | null;
  /** 创建接口详情里的内容首图（无封面时使用） */
  thumbnailSrc?: string | null;
  coverKey?: string | null;
  nodeCount?: number;
}

export function toProjectSummary(source: ProjectSummarySource): ProjectSummary {
  const coverKey = source.coverKey ?? undefined;
  return {
    id: source.id,
    name: source.name,
    revision: source.revision ?? 1,
    updatedAt: typeof source.updatedAt === "number"
      ? source.updatedAt
      : toTimestamp(source.updatedAt, Date.now()),
    thumbnail: source.thumbnail ?? coverKey ?? source.thumbnailSrc ?? undefined,
    coverKey,
    nodeCount: source.nodeCount ?? 0,
  };
}

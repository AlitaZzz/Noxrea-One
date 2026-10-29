/**
 * 生成面板的上游引用投影（纯函数）。
 *
 * 输入只有「决定结果的部分」：入边、上游节点的类型与数据；拖动只替换 position，
 * 不影响结果。消费方以结构比较（sameUpstreamRefs）作为 zustand 的 equalityFn，
 * 内容不变即复用上次结果，面板不随位置帧重渲染——不依赖全局缓存与字符串键。
 */
import type { Edge } from "@xyflow/react";

import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

/** 上游文本引用（生成面板）：内容已 trim，空内容不进入结果。 */
export interface UpstreamTextRef {
  id: string;
  content: string;
}

/** 上游媒体引用（生成面板）：src / label 已 trim，空 src 不进入结果。 */
export interface UpstreamMediaRef {
  id: string;
  src: string;
  label: string;
}

export interface NodeUpstreamRefs {
  /** 上游图片 src，按节点数组顺序（与生成面板既有顺序一致）。 */
  images: string[];
  /** 上游文本，按连线顺序，按节点 id 去重。 */
  texts: UpstreamTextRef[];
  /** 上游音频，按连线顺序，按节点 id 与 src 双重去重。 */
  audios: UpstreamMediaRef[];
  /** 上游视频，按连线顺序，按节点 id 与 src 双重去重。 */
  videos: UpstreamMediaRef[];
}

/** 媒体去重状态：节点 id 与 src 各一个集合，随引用收集一起传递。 */
interface MediaSeen {
  ids: Set<string>;
  srcs: Set<string>;
}

function createMediaSeen(): MediaSeen {
  return { ids: new Set(), srcs: new Set() };
}

/** 媒体引用统一规则：src / label trim，空 src 丢弃，按节点 id 与 src 双重去重。 */
function pushMediaRef(refs: UpstreamMediaRef[], seen: MediaSeen, node: AnyNode): void {
  const src = ((node.data as { src?: string }).src || "").trim();
  const label = ((node.data as { label?: string }).label || "").trim();
  if (src === "" || seen.ids.has(node.id) || seen.srcs.has(src)) return;
  seen.ids.add(node.id);
  seen.srcs.add(src);
  refs.push({ id: node.id, src, label });
}

export function buildUpstreamRefs(nodes: AnyNode[], edges: Edge[], nodeId: string): NodeUpstreamRefs {
  const incoming: Edge[] = [];
  const upstreamIds = new Set<string>();
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    incoming.push(edge);
    upstreamIds.add(edge.source);
  }

  // 图片按节点数组顺序（生成面板既有顺序），其余按连线顺序
  const byId = new Map<string, AnyNode>();
  const images: string[] = [];
  for (const node of nodes) {
    if (!upstreamIds.has(node.id)) continue;
    byId.set(node.id, node);
    if (node.type !== NODE_TYPE.IMAGE) continue;
    const src = (node.data as { src?: string }).src;
    if (src) images.push(src);
  }

  const texts: UpstreamTextRef[] = [];
  const audios: UpstreamMediaRef[] = [];
  const videos: UpstreamMediaRef[] = [];
  const seenTextIds = new Set<string>();
  const seenAudios = createMediaSeen();
  const seenVideos = createMediaSeen();

  for (const edge of incoming) {
    const node = byId.get(edge.source);
    if (!node) continue;
    if (node.type === NODE_TYPE.TEXT) {
      const content = ((node.data as { plainText?: string }).plainText || "").trim();
      if (content === "" || seenTextIds.has(node.id)) continue;
      seenTextIds.add(node.id);
      texts.push({ id: node.id, content });
    } else if (node.type === NODE_TYPE.AUDIO) {
      pushMediaRef(audios, seenAudios, node);
    } else if (node.type === NODE_TYPE.VIDEO) {
      pushMediaRef(videos, seenVideos, node);
    }
  }

  return { images, texts, audios, videos };
}

/** 逐项比较两个引用列表（长度优先，再按给定相等口径逐项比较）。 */
function sameRefList<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!same(a[i], b[i])) return false;
  }
  return true;
}

function sameMediaRef(x: UpstreamMediaRef, y: UpstreamMediaRef): boolean {
  return x.id === y.id && x.src === y.src && x.label === y.label;
}

/** 上游引用按值相等：同一内容视为同一结果，供订阅选择器的 equalityFn 使用。 */
export function sameUpstreamRefs(a: NodeUpstreamRefs, b: NodeUpstreamRefs): boolean {
  if (a === b) return true;
  return (
    sameRefList(a.images, b.images, (x, y) => x === y) &&
    sameRefList(a.texts, b.texts, (x, y) => x.id === y.id && x.content === y.content) &&
    sameRefList(a.audios, b.audios, sameMediaRef) &&
    sameRefList(a.videos, b.videos, sameMediaRef)
  );
}

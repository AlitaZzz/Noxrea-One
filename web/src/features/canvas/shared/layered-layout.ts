/**
 * 分层布局（纯函数，无 React / store 依赖，便于单测）。
 *
 * 画布整理的「分层」模式与组内「智能布局」共用这一份实现：一列 = 一个拓扑层，
 * 上游在左、下游在右。主 DAG 交给 dagre 求分层（rank assignment）；层内顺序与
 * 坐标由读序决定——同一层按读序自上而下堆叠，整列相对最高列垂直居中，列宽取
 * 该层最宽节点。环内节点与孤立节点不能喂给 dagre（dagre 要求无环），单列排到
 * 主图右侧并相对主图垂直居中，不打断主链路。
 *
 * 布局是「拓扑 + 节点尺寸 + 读序」的纯函数，且必须幂等：对布局结果再次执行，
 * 层内顺序仍是同一顺序。同列节点 x 相同，读序在带内按 x 排序（x 相同时保持
 * 中线顺序，即自上而下），因此输出再次读序恰好还原层内堆叠顺序，连续执行
 * 收敛到同一结果。
 * 这也是不使用 dagre 层内次序与坐标的原因：dagre 的层内次序不保证与投喂次序
 * 一致，用其输出反推下一次读序会让同层支路来回翻转（周期 2 振荡）。
 * 节点按入参顺序投喂 dagre 而非读序：rank 只由拓扑与尺寸决定，读序只参与层内
 * 排序，避免「读序 → 坐标 → 读序」的反馈环。
 */
import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import type { Edge } from "@xyflow/react";

import { sortBoxesByReading } from "./reading-order";

/** 参与布局的节点盒子：布局期几何快照（x / y 决定读序，width / height 决定占位） */
export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把连线端点映射成布局单元的依赖边：两端都解析成功且不相同时构成上下游关系。
 * 自环、悬空端点与映射到同一单元的连线自然被过滤。
 */
export function collectLinks(
  edges: readonly Edge[],
  resolve: (nodeId: string) => string | undefined,
): Array<[string, string]> {
  const links: Array<[string, string]> = [];
  for (const edge of edges) {
    const source = resolve(edge.source);
    const target = resolve(edge.target);
    if (source !== undefined && target !== undefined && source !== target) {
      links.push([source, target]);
    }
  }
  return links;
}

export interface LayeredOptions {
  /** 同层节点之间的垂直净间距 */
  gap: number;
  /** 层与层之间的水平净间距 */
  columnGap: number;
}

/**
 * 分层排布：节点 + 节点级连线 → 节点左上角坐标。
 *
 * 连线端点不在 nodes 中或两端相同时忽略，平行边只算一条——它们都不构成
 * 上下游关系。
 */
export function packLayered(
  nodes: LayoutBox[],
  links: Array<[string, string]>,
  { gap, columnGap }: LayeredOptions,
): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return placed;

  // 读序是层内顺序的唯一来源：序号越小越靠上
  const order = sortBoxesByReading(nodes);
  const seedIndex = new Map<string, number>();
  order.forEach((node, index) => seedIndex.set(node.id, index));

  // —— 构建有向图 ——
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    outgoing.set(node.id, new Set());
    indegree.set(node.id, 0);
  }
  for (const [source, target] of links) {
    const next = outgoing.get(source);
    if (source === target || !next || next.has(target) || !indegree.has(target)) continue;
    next.add(target);
    indegree.set(target, indegree.get(target)! + 1);
  }

  // —— Kahn 判环：环内节点卡在未访问集合里，不能喂给 dagre ——
  const remaining = new Map(indegree);
  const visited = new Set<string>();
  const ready = order.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  while (ready.length > 0) {
    const id = ready.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of outgoing.get(id)!) {
      const degree = remaining.get(next)! - 1;
      remaining.set(next, degree);
      if (degree <= 0 && !visited.has(next)) ready.push(next);
    }
  }

  // 成员归属与顺序无关，按入参顺序收集（稳定的入参顺序 = 稳定的 dagre 输入）
  const main: LayoutBox[] = [];
  const tail: LayoutBox[] = [];
  for (const node of nodes) {
    const isolated = indegree.get(node.id) === 0 && outgoing.get(node.id)!.size === 0;
    if (!visited.has(node.id) || isolated) tail.push(node);
    else main.push(node);
  }

  // —— 主 DAG：dagre 只求分层，层内顺序与坐标由读序决定 ——
  let mainWidth = 0;
  let mainHeight = 0;
  if (main.length > 0) {
    const graph = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>();
    graph.setGraph({ rankdir: "LR", nodesep: gap, ranksep: columnGap });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of main) graph.setNode(node.id, { width: node.width, height: node.height });
    for (const [source, target] of links) {
      if (!graph.hasNode(source) || !graph.hasNode(target)) continue;
      graph.setEdge(source, target);
    }
    dagre.layout(graph);

    const columns = new Map<number, LayoutBox[]>();
    for (const node of main) {
      const rank = graph.node(node.id)!.rank!;
      const column = columns.get(rank);
      if (column) column.push(node);
      else columns.set(rank, [node]);
    }
    const ranks = [...columns.keys()].sort((a, b) => a - b);
    const columnWidths = ranks.map((rank) =>
      Math.max(...columns.get(rank)!.map((node) => node.width)),
    );
    const columnHeights = ranks.map((rank) => {
      const column = columns.get(rank)!;
      return column.reduce((sum, node) => sum + node.height, 0) + gap * (column.length - 1);
    });
    const tallest = Math.max(...columnHeights);

    let columnX = 0;
    ranks.forEach((rank, index) => {
      // 层内按读序自上而下堆叠；列内左对齐，保证同列节点 x 相同
      const column = [...columns.get(rank)!].sort(
        (a, b) => seedIndex.get(a.id)! - seedIndex.get(b.id)!,
      );
      let cursorY = (tallest - columnHeights[index]) / 2;
      for (const node of column) {
        placed.set(node.id, { x: columnX, y: cursorY });
        cursorY += node.height + gap;
      }
      columnX += columnWidths[index] + columnGap;
    });
    mainWidth = columnX - columnGap;
    mainHeight = tallest;
  }

  // —— 环内节点与孤立节点：单列排到主图右侧，整列相对主图垂直居中 ——
  const tailOrder = [...tail].sort((a, b) => seedIndex.get(a.id)! - seedIndex.get(b.id)!);
  const tailHeight =
    tailOrder.reduce((sum, node) => sum + node.height, 0) +
    gap * Math.max(0, tailOrder.length - 1);
  const tailX = mainWidth > 0 ? mainWidth + columnGap : 0;
  let tailY = Math.max(0, (mainHeight - tailHeight) / 2);
  for (const node of tailOrder) {
    placed.set(node.id, { x: tailX, y: tailY });
    tailY += node.height + gap;
  }

  return placed;
}

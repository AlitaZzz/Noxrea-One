/**
 * 选区级布局（纯函数，无 React / store 依赖）。
 *
 * 规则见 specs/canvas-multi-selection-layout.md 4.2–4.5：
 * - 布局单元：选中的组（原子单元，成员随组移动）与选中的顶层非组节点；
 * - 成员的父组未被选中时，成员不参与布局、不计入单元；父组也被选中时去重；
 * - 单元间连线映射到所属单元，组内连线 / 自环 / 悬空端点由 collectLinks 过滤；
 * - 排列核心与组内布局共用 layout-modes，结果以参与单元并集中心为锚整体平移。
 */
import type { Edge } from "@xyflow/react";

import type { AnyNode } from "@/features/canvas/types";

import { isGroupNode, memberParentId } from "./group-membership";
import { collectLinks, type LayoutBox } from "./layered-layout";
import { arrangeBoxes, type CanvasLayoutMode } from "./layout-modes";
import { measureNode } from "./node-size";

/** 选区布局单元：世界坐标的原子盒；`memberIds` 只参与边映射，不产出位置 */
export interface SelectionLayoutUnit {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  memberIds: string[];
}

export interface SelectionLayoutResult {
  /** 单元 id → 新世界坐标（只含组节点与顶层节点，成员相对坐标不变） */
  positions: Map<string, { x: number; y: number }>;
  /** 参与布局的单元数 */
  unitCount: number;
  /** 位置实际发生变化的单元数；为 0 表示无需写入 */
  movedCount: number;
}

/**
 * 收集选区布局单元（O(n) 线性遍历，不扫描 edges）。
 *
 * 按 nodes 数组顺序返回，作为排列核心的稳定输入顺序。选中的组成员索引只在
 * 需要时建立一次；每个组的成员只遍历一遍全表。
 */
export function collectSelectionLayoutUnits(
  nodes: readonly AnyNode[],
  selectedIds: ReadonlySet<string>,
): SelectionLayoutUnit[] {
  if (selectedIds.size === 0) return [];

  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const units: SelectionLayoutUnit[] = [];
  const groupUnitById = new Map<string, SelectionLayoutUnit>();

  for (const node of nodes) {
    if (!selectedIds.has(node.id)) continue;

    if (isGroupNode(node)) {
      const { width, height } = measureNode(node);
      const unit: SelectionLayoutUnit = {
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        width,
        height,
        memberIds: [],
      };
      units.push(unit);
      groupUnitById.set(node.id, unit);
      continue;
    }

    const parentId = memberParentId(node);
    if (parentId) {
      const parent = nodeById.get(parentId);
      // 父组被选中：成员属于该组单元，不单独成单元；父组未选中：成员不参与布局。
      // 父不存在或不是组：脏数据按顶层处理（与 tidy-layout 的 collectUnits 一致）。
      if (parent && isGroupNode(parent)) continue;
    }

    const { width, height } = measureNode(node);
    units.push({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width,
      height,
      memberIds: [],
    });
  }

  if (groupUnitById.size > 0) {
    for (const node of nodes) {
      const parentId = memberParentId(node);
      if (!parentId) continue;
      groupUnitById.get(parentId)?.memberIds.push(node.id);
    }
  }

  return units;
}

/** 单元级依赖：连线端点映射到所属单元，组内连线、自环与悬空边被过滤 */
export function selectionLinks(
  units: readonly SelectionLayoutUnit[],
  edges: readonly Edge[],
): Array<[string, string]> {
  const unitOfNode = new Map<string, string>();
  for (const unit of units) {
    unitOfNode.set(unit.id, unit.id);
    for (const memberId of unit.memberIds) unitOfNode.set(memberId, unit.id);
  }

  return collectLinks(edges, (nodeId) => unitOfNode.get(nodeId));
}

/**
 * 计算选区布局：单元 → 排列核心 → 以布局前单元并集中心为锚整体平移。
 *
 * 中心取参与布局的单元并集，不取完整选中集包围盒（可能包含被排除的成员）。
 * 不做吸附、不取整；移动量按单元统计，阈值 0.5px 与 tidy-layout 同口径。
 */
export function computeSelectionLayout(
  nodes: readonly AnyNode[],
  edges: readonly Edge[],
  selectedIds: ReadonlySet<string>,
  mode: CanvasLayoutMode,
): SelectionLayoutResult {
  const units = collectSelectionLayoutUnits(nodes, selectedIds);
  if (units.length === 0) {
    return { positions: new Map(), unitCount: 0, movedCount: 0 };
  }

  const boxes: LayoutBox[] = units.map((unit) => ({
    id: unit.id,
    x: unit.x,
    y: unit.y,
    width: unit.width,
    height: unit.height,
  }));
  const placed = arrangeBoxes(boxes, selectionLinks(units, edges), mode);

  let beforeMinX = Infinity;
  let beforeMinY = Infinity;
  let beforeMaxX = -Infinity;
  let beforeMaxY = -Infinity;
  let afterMinX = Infinity;
  let afterMinY = Infinity;
  let afterMaxX = -Infinity;
  let afterMaxY = -Infinity;
  for (const unit of units) {
    beforeMinX = Math.min(beforeMinX, unit.x);
    beforeMinY = Math.min(beforeMinY, unit.y);
    beforeMaxX = Math.max(beforeMaxX, unit.x + unit.width);
    beforeMaxY = Math.max(beforeMaxY, unit.y + unit.height);

    const p = placed.get(unit.id);
    if (!p) continue;
    afterMinX = Math.min(afterMinX, p.x);
    afterMinY = Math.min(afterMinY, p.y);
    afterMaxX = Math.max(afterMaxX, p.x + unit.width);
    afterMaxY = Math.max(afterMaxY, p.y + unit.height);
  }
  if (!Number.isFinite(afterMinX) || !Number.isFinite(afterMinY)) {
    return { positions: new Map(), unitCount: units.length, movedCount: 0 };
  }

  const dx =
    (beforeMinX + beforeMaxX) / 2 - (afterMinX + afterMaxX) / 2;
  const dy =
    (beforeMinY + beforeMaxY) / 2 - (afterMinY + afterMaxY) / 2;

  const positions = new Map<string, { x: number; y: number }>();
  let movedCount = 0;
  for (const unit of units) {
    const p = placed.get(unit.id);
    if (!p) continue;
    const next = { x: p.x + dx, y: p.y + dy };
    if (
      Math.abs(next.x - unit.x) > 0.5 ||
      Math.abs(next.y - unit.y) > 0.5
    ) {
      movedCount += 1;
    }
    positions.set(unit.id, next);
  }

  return { positions, unitCount: units.length, movedCount };
}

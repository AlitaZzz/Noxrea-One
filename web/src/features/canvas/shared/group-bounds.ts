/**
 * 组框几何工具：成员变化时重算组框矩形（绝对坐标系，成员不嵌套在组内）。
 *
 * 设计约定：
 * - 加入成员时组框「只扩不缩」——以当前组框矩形为底，与成员外接矩形
 *   （含 GROUP_NODE_PADDING）取并集，用户手动放大的组框不被破坏；
 * - 组变空时收缩到最小尺寸（保持左上角），避免留下巨大空壳；
 * - 尺寸取值链与 tidy-layout 一致：measured > style > 兜底。
 */
import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_MIN_HEIGHT, GROUP_NODE_MIN_WIDTH, GROUP_NODE_PADDING } from "@/lib/constants";

import { measureNode } from "./tidy-layout";

/** 成员归属变化后重算组框矩形。无需变化（差异 < 0.5px）时返回 null。 */
export function computeFittedGroupRect(
  group: AnyNode,
  members: AnyNode[],
): { x: number; y: number; width: number; height: number } | null {
  const gSize = measureNode(group);
  let x = group.position.x;
  let y = group.position.y;
  let maxX = x + gSize.width;
  let maxY = y + gSize.height;

  if (members.length === 0) {
    // 空组：收缩到最小尺寸，保持左上角不动
    maxX = x + GROUP_NODE_MIN_WIDTH;
    maxY = y + GROUP_NODE_MIN_HEIGHT;
  } else {
    for (const m of members) {
      const s = measureNode(m);
      x = Math.min(x, m.position.x - GROUP_NODE_PADDING);
      y = Math.min(y, m.position.y - GROUP_NODE_PADDING);
      maxX = Math.max(maxX, m.position.x + s.width + GROUP_NODE_PADDING);
      maxY = Math.max(maxY, m.position.y + s.height + GROUP_NODE_PADDING);
    }
  }

  const width = Math.max(GROUP_NODE_MIN_WIDTH, maxX - x);
  const height = Math.max(GROUP_NODE_MIN_HEIGHT, maxY - y);

  if (
    Math.abs(x - group.position.x) < 0.5 &&
    Math.abs(y - group.position.y) < 0.5 &&
    Math.abs(width - gSize.width) < 0.5 &&
    Math.abs(height - gSize.height) < 0.5
  ) {
    return null;
  }
  return { x, y, width, height };
}

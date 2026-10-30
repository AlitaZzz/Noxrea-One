import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

/** 框选单测的节点工厂：只提供命中与几何换算需要的最小字段。 */
function marqueeNode(
  id: string,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
): AnyNode {
  return {
    id,
    type: NODE_TYPE.TEXT,
    position: { x, y },
    data: {},
    ...extra,
  } as unknown as AnyNode;
}

export interface MarqueeBoxOptions {
  width?: number;
  height?: number;
  [key: string]: unknown;
}

/** 带尺寸的节点工厂（默认 100×100），供命中与手势用例共用。 */
export function marqueeBox(
  id: string,
  x: number,
  y: number,
  { width = 100, height = 100, ...extra }: MarqueeBoxOptions = {},
): AnyNode {
  return marqueeNode(id, x, y, { style: { width, height }, ...extra });
}

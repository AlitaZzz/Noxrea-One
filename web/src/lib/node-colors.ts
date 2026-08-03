import { NODE_TYPE } from "@/lib/types";

export { NODE_TYPE } from "@/lib/types";

// 节点类型对应的语义色，用于小地图 minimap 节点着色。
// 各节点的 input/output handle 小圆点颜色以节点组件内写死的实际显示色为准，
// 此处与之保持一致，保证小地图与画布上节点圆点颜色对齐。
export const NODE_TYPE_COLOR: Record<string, string> = {
  [NODE_TYPE.TEXT]: "#1677ff",
  [NODE_TYPE.IMAGE]: "#52c41a",
  [NODE_TYPE.VIDEO]: "#13c2c2",
  [NODE_TYPE.AUDIO]: "#fa8c16",
  [NODE_TYPE.GROUP]: "#722ed1",
  [NODE_TYPE.DIRECTOR]: "#722ed1",
};

export const DEFAULT_NODE_COLOR = "#1677ff";

export function getNodeColor(type: string | undefined): string {
  if (!type) return DEFAULT_NODE_COLOR;
  return NODE_TYPE_COLOR[type] ?? DEFAULT_NODE_COLOR;
}

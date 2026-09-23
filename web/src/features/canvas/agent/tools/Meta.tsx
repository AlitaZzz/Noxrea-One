/**
 * Agent 工具元信息注册表（ActionUtil 式）：每个画布工具对应一个图标、
 * 中文标题与参数描述模板。聊天面板操作行展示文案 = intent ?? describe ?? label ?? name。
 * describe 通过 useCanvasStore.getState() 同步查询节点标题，查不到回退 id 前 6 位。
 */
import type { ReactNode } from "react";

import ArrangeIcon from "@/components/ui/icons/agent/ArrangeIcon";
import CanvasStateIcon from "@/components/ui/icons/agent/CanvasStateIcon";
import ConnectNodesIcon from "@/components/ui/icons/agent/ConnectNodesIcon";
import CreateNodeIcon from "@/components/ui/icons/agent/CreateNodeIcon";
import DeleteNodeIcon from "@/components/ui/icons/agent/DeleteNodeIcon";
import DuplicateIcon from "@/components/ui/icons/agent/DuplicateIcon";
import MoveIcon from "@/components/ui/icons/agent/MoveIcon";
import NodeDetailIcon from "@/components/ui/icons/agent/NodeDetailIcon";
import SelectIcon from "@/components/ui/icons/agent/SelectIcon";
import UnlinkIcon from "@/components/ui/icons/agent/UnlinkIcon";
import UpdateNodeIcon from "@/components/ui/icons/agent/UpdateNodeIcon";
import ViewportFocusIcon from "@/components/ui/icons/agent/ViewportFocusIcon";
import type { ToolCallView } from "@/features/canvas/agent/types";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

const KIND_NAMES: Record<string, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
  director: "导演台",
  group: "编组",
};

/** 按节点 id 查标题；查不到回退 id 前 6 位 */
function nodeLabel(id: string): string {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
  const label = node?.data?.label;
  return typeof label === "string" && label ? label : id.slice(0, 6);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

export interface ToolMeta {
  icon: ReactNode;
  title: string;
  describe: (args: Record<string, unknown>) => string;
}

export const TOOL_META: Record<string, ToolMeta> = {
  create_node: {
    icon: <CreateNodeIcon />,
    title: "创建节点",
    describe: (args) => {
      const items = asArray(args.nodes);
      if (items.length === 0) return "新建节点";
      const counts = new Map<string, number>();
      for (const it of items) {
        const kind = typeof (it as { kind?: unknown }).kind === "string" ? (it as { kind: string }).kind : "text";
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      const summary = [...counts.entries()].map(([k, n]) => `${KIND_NAMES[k] ?? k}${n}`).join("、");
      return `新建 ${items.length} 个节点（${summary}）`;
    },
  },
  update_node: {
    icon: <UpdateNodeIcon />,
    title: "更新节点",
    describe: (args) => {
      const id = asString(args.nodeId);
      return id ? `更新节点「${nodeLabel(id)}」` : "更新节点";
    },
  },
  delete_nodes: {
    icon: <DeleteNodeIcon />,
    title: "删除节点",
    describe: (args) => {
      const ids = asArray(args.nodeIds);
      return ids.length ? `删除 ${ids.length} 个节点` : "删除节点";
    },
  },
  connect_nodes: {
    icon: <ConnectNodesIcon />,
    title: "连接节点",
    describe: (args) => {
      const edges = asArray(args.edges);
      return edges.length ? `创建 ${edges.length} 条连线` : "创建连线";
    },
  },
  delete_edges: {
    icon: <UnlinkIcon />,
    title: "删除连线",
    describe: (args) => {
      const edges = asArray(args.edges);
      return edges.length ? `删除 ${edges.length} 条连线` : "删除连线";
    },
  },
  duplicate_node: {
    icon: <DuplicateIcon />,
    title: "复制节点",
    describe: (args) => {
      const id = asString(args.nodeId);
      return id ? `复制节点「${nodeLabel(id)}」` : "复制节点";
    },
  },
  move_node: {
    icon: <MoveIcon />,
    title: "移动节点",
    describe: (args) => {
      const id = asString(args.nodeId);
      const label = id ? `「${nodeLabel(id)}」` : "节点";
      if (typeof args.x === "number" && typeof args.y === "number") {
        return `移动${label}到 (${Math.round(args.x)}, ${Math.round(args.y)})`;
      }
      if (args.alignTo === "center") return `移动${label}到视口中心`;
      const ref = asString(args.alignTo);
      if (ref) return `移动${label}到「${nodeLabel(ref)}」旁`;
      return `移动${label}`;
    },
  },
  arrange_canvas: {
    icon: <ArrangeIcon />,
    title: "整理画布",
    describe: () => "整理画布布局",
  },
  set_viewport: {
    icon: <ViewportFocusIcon />,
    title: "调整视口",
    describe: (args) => {
      const id = asString(args.nodeId);
      if (id) return `聚焦节点「${nodeLabel(id)}」`;
      if (typeof args.x === "number" && typeof args.y === "number") {
        return `移动视口到 (${Math.round(args.x)}, ${Math.round(args.y)})`;
      }
      return "调整视口";
    },
  },
  select_nodes: {
    icon: <SelectIcon />,
    title: "选中节点",
    describe: (args) => {
      const ids = asArray(args.nodeIds);
      const focus = args.focus === true;
      return ids.length ? `选中 ${ids.length} 个节点${focus ? "并聚焦" : ""}` : "选中节点";
    },
  },
  get_canvas_state: {
    icon: <CanvasStateIcon />,
    title: "查看画布状态",
    describe: (args) => {
      const r = args.region;
      const hasRegion = r != null && typeof r === "object" && !Array.isArray(r)
        && ["minX", "maxX", "minY", "maxY"].every((k) => typeof (r as Record<string, unknown>)[k] === "number");
      return hasRegion ? "按坐标范围读取画布状态" : "读取画布当前状态";
    },
  },
  get_node_detail: {
    icon: <NodeDetailIcon />,
    title: "读取节点内容",
    describe: (args) => {
      const ids = asArray(args.nodeIds);
      if (ids.length === 0) return "读取节点内容";
      const shown = ids.slice(0, 3).map((id) => `「${nodeLabel(String(id))}」`).join("、");
      const more = ids.length > 3 ? ` 等 ${ids.length} 个节点` : "";
      return `读取节点内容：${shown}${more}`;
    },
  },
  message_user: {
    icon: <CanvasStateIcon />,
    title: "回复用户",
    describe: () => "",
  },
};

/** 解析工具调用参数 JSON（容错：非法或为空按空对象） */
export function parseToolArgs(call: Pick<ToolCallView, "args">): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.args || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 操作行文案：intent（模型的一句话说明）优先，其次 describe 模板，最后 label / 工具名。
 * 历史消息无 intent 时自动回退，模型没写 intent 时 describe 兜底。
 */
export function actionRowText(call: ToolCallView): string {
  const args = parseToolArgs(call);
  const intent = asString(args.intent);
  if (intent) return intent;
  const meta = TOOL_META[call.name];
  const described = meta?.describe(args);
  if (described) return described;
  return call.label ?? call.name;
}

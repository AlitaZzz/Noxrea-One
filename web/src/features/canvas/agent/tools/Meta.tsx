/**
 * Agent 工具元信息注册表（ActionUtil 式）：每个画布工具对应一个图标、
 * 标题与参数描述模板。聊天面板操作行展示文案 = intent ?? describe ?? label ?? name。
 * describe 通过 useCanvasStore.getState() 同步查询节点标题，查不到回退 id 前 6 位。
 * 标题与 describe 均为 UI 文案，经 i18n 取当前语言；在渲染期同步调用。
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
import i18n from "@/lib/i18n/config";

/** 节点 kind → i18n key（与画布元素面板共用 node.* 文案） */
const KIND_KEYS: Record<string, string> = {
  text: "node.text",
  image: "node.image",
  video: "node.video",
  audio: "node.audio",
  director: "node.director",
  group: "node.group",
};

const kindName = (k: string): string => (KIND_KEYS[k] ? i18n.t(KIND_KEYS[k]) : k);

/** 按节点 id 查标题；查不到回退 id 前 6 位 */
function nodeLabel(id: string): string {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
  const label = node?.data?.label;
  return typeof label === "string" && label ? label : id.slice(0, 6);
}

/** 带书名号的节点引用；无 id 时回退到「节点」 */
function quotedLabel(id: string | undefined): string {
  return id ? i18n.t("agent.tool.nodeLabel", { label: nodeLabel(id) }) : i18n.t("agent.tool.nodeFallback");
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

export interface ToolMeta {
  icon: ReactNode;
  describe: (args: Record<string, unknown>) => string;
}

export const TOOL_META: Record<string, ToolMeta> = {
  create_node: {
    icon: <CreateNodeIcon />,
    describe: (args) => {
      const t = (k: string, opts?: Record<string, unknown>) => i18n.t(k, opts);
      const items = asArray(args.nodes);
      if (items.length === 0) return t("agent.tool.createNode");
      const counts = new Map<string, number>();
      for (const it of items) {
        const kind = typeof (it as { kind?: unknown }).kind === "string" ? (it as { kind: string }).kind : "text";
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      // 每类「名称×数量」与分隔符均经 i18n 取当前语言形态，不硬编码中文标点
      const summary = [...counts.entries()]
        .map(([k, n]) => i18n.t("agent.tool.kindCount", { name: kindName(k), count: n }))
        .join(i18n.t("agent.tool.listSeparator"));
      return t("agent.tool.createNodeN", { count: items.length, summary });
    },
  },
  update_node: {
    icon: <UpdateNodeIcon />,
    describe: (args) => {
      const id = asString(args.nodeId);
      return id ? i18n.t("agent.tool.updateNode", { label: nodeLabel(id) }) : i18n.t("agent.tool.updateNodePlain");
    },
  },
  delete_nodes: {
    icon: <DeleteNodeIcon />,
    describe: (args) => {
      const ids = asArray(args.nodeIds);
      return ids.length ? i18n.t("agent.tool.deleteNodeN", { count: ids.length }) : i18n.t("agent.tool.deleteNode");
    },
  },
  connect_nodes: {
    icon: <ConnectNodesIcon />,
    describe: (args) => {
      const edges = asArray(args.edges);
      return edges.length ? i18n.t("agent.tool.connectN", { count: edges.length }) : i18n.t("agent.tool.connect");
    },
  },
  delete_edges: {
    icon: <UnlinkIcon />,
    describe: (args) => {
      const edges = asArray(args.edges);
      return edges.length ? i18n.t("agent.tool.deleteEdgesN", { count: edges.length }) : i18n.t("agent.tool.deleteEdges");
    },
  },
  duplicate_node: {
    icon: <DuplicateIcon />,
    describe: (args) => {
      const id = asString(args.nodeId);
      return id ? i18n.t("agent.tool.copyNodeLabeled", { label: nodeLabel(id) }) : i18n.t("agent.tool.copyNode");
    },
  },
  move_node: {
    icon: <MoveIcon />,
    describe: (args) => {
      const id = asString(args.nodeId);
      const label = quotedLabel(id);
      if (typeof args.x === "number" && typeof args.y === "number") {
        return i18n.t("agent.tool.moveNodeTo", { label, x: Math.round(args.x), y: Math.round(args.y) });
      }
      if (args.alignTo === "center") return i18n.t("agent.tool.moveNodeCenter", { label });
      const ref = asString(args.alignTo);
      if (ref) return i18n.t("agent.tool.moveNodeBeside", { label, ref: nodeLabel(ref) });
      return i18n.t("agent.tool.moveNodeLabeled", { label });
    },
  },
  arrange_canvas: {
    icon: <ArrangeIcon />,
    describe: () => i18n.t("agent.tool.arrangeCanvas"),
  },
  set_viewport: {
    icon: <ViewportFocusIcon />,
    describe: (args) => {
      const id = asString(args.nodeId);
      if (id) return i18n.t("agent.tool.focusNode", { label: nodeLabel(id) });
      if (typeof args.x === "number" && typeof args.y === "number") {
        return i18n.t("agent.tool.moveViewportTo", { x: Math.round(args.x), y: Math.round(args.y) });
      }
      return i18n.t("agent.tool.setViewport");
    },
  },
  select_nodes: {
    icon: <SelectIcon />,
    describe: (args) => {
      const ids = asArray(args.nodeIds);
      const focus = args.focus === true;
      if (!ids.length) return i18n.t("agent.tool.selectNodes");
      return focus
        ? i18n.t("agent.tool.selectNodesNFocus", { count: ids.length })
        : i18n.t("agent.tool.selectNodesN", { count: ids.length });
    },
  },
  get_canvas_state: {
    icon: <CanvasStateIcon />,
    describe: (args) => {
      const r = args.region;
      const hasRegion = r != null && typeof r === "object" && !Array.isArray(r)
        && ["minX", "maxX", "minY", "maxY"].every((k) => typeof (r as Record<string, unknown>)[k] === "number");
      return hasRegion ? i18n.t("agent.tool.canvasStateRegion") : i18n.t("agent.tool.canvasState");
    },
  },
  get_node_detail: {
    icon: <NodeDetailIcon />,
    describe: (args) => {
      const ids = asArray(args.nodeIds);
      if (ids.length === 0) return i18n.t("agent.tool.readNodes");
      const shown = ids.slice(0, 3).map((id) => i18n.t("agent.tool.nodeLabel", { label: nodeLabel(String(id)) })).join("、");
      const more = ids.length > 3 ? i18n.t("agent.tool.readNodesMore", { count: ids.length }) : "";
      return i18n.t("agent.tool.readNodesList", { labels: shown, more });
    },
  },
  message_user: {
    icon: <CanvasStateIcon />,
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

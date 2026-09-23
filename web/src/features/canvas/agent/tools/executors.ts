/**
 * 画布 Agent 工具执行器。
 * 接收后端下发的 tool_call，在画布上执行对应操作，并把结果整理成回传给模型的文本。
 * 所有变更通过 {skipHistory:true} 落库，由调用方在每轮结束后统一压一次历史快照，
 * 保证 agent 的一批操作 = 用户的一次撤销。
 */
"use client";

import { getCanvasAgentRuntime } from "@/features/canvas/agent/Runtime";
import type { AgentToolCall, AgentToolResult } from "@/features/canvas/agent/types";
import {
  createAudioNode,
  createEdge,
  createGroupNode,
  createImageNode,
  createTextNode,
  createVideoNode,
  directorNode as createDirectorNode,
} from "@/features/canvas/node-defaults";
import { readLastModel } from "@/features/canvas/shared/last-model";
import { applyRatioToNode, ratioToNodeSize } from "@/features/canvas/shared/ratio-size";
import {
  findFreePosition,
  getViewportCenter,
  markDirtyImmediate,
  useCanvasStore,
} from "@/features/canvas/stores/canvas-store";
import type { AnyNode, ImageGenSettings, TextNodeData, VideoGenSettings } from "@/features/canvas/types";
import { canConnect, NODE_TYPE, VALID_CONNECTION_OUTPUTS } from "@/lib/constants";
import { useModelStore } from "@/lib/model-store";
import type { ModelCapability } from "@/lib/types/models";

// ── 工厂表 ──

// 工具 kind 枚举是 LLM 契约（与 NODE_TYPE 的 "-node" 后缀持久化词汇刻意解耦），
// 须与 server/services/agent/tools/definitions.ts 的 NODE_KINDS 保持一致（跨包无法共享类型）
const TOOL_NODE_KINDS = ["text", "image", "video", "audio", "director", "group"] as const;
type ToolNodeKind = (typeof TOOL_NODE_KINDS)[number];
type CanvasNodeType = (typeof NODE_TYPE)[keyof typeof NODE_TYPE];

/** 工具 kind → 画布节点类型。Record<ToolNodeKind, …> 保证新增 kind 漏写映射时编译报错 */
const KIND_TO_NODE_TYPE: Record<ToolNodeKind, CanvasNodeType> = {
  text: NODE_TYPE.TEXT,
  image: NODE_TYPE.IMAGE,
  video: NODE_TYPE.VIDEO,
  audio: NODE_TYPE.AUDIO,
  director: NODE_TYPE.DIRECTOR,
  group: NODE_TYPE.GROUP,
};

const NODE_FACTORIES: Record<CanvasNodeType, (at: { x: number; y: number }) => AnyNode> = {
  [NODE_TYPE.TEXT]: createTextNode,
  [NODE_TYPE.IMAGE]: createImageNode,
  [NODE_TYPE.VIDEO]: createVideoNode,
  [NODE_TYPE.AUDIO]: createAudioNode,
  [NODE_TYPE.DIRECTOR]: createDirectorNode,
  [NODE_TYPE.GROUP]: (at) => createGroupNode(at, { width: 480, height: 320 }),
};

function nodeSize(n: AnyNode): { width: number; height: number } {
  return {
    width: (n.style?.width as number) ?? 300,
    height: (n.style?.height as number) ?? 200,
  };
}

/** 纯文本 → 段落化富文本 HTML（供 Tiptap 编辑，语义同 canvas-edit-actions 的粘贴分支） */
function textToHtml(text: string): string {
  const escape = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split("\n").map(escape).join("<br>")}</p>`)
    .join("");
}

/** 按节点类型把 prompt/content/title 写入节点数据 */
function fillNodeData(node: AnyNode, item: { kind: CanvasNodeType; content?: string; prompt?: string; title?: string }): AnyNode {
  const data = { ...node.data } as Record<string, unknown>;
  if (item.title != null && item.title !== "") data.label = item.title;

  if (item.kind === NODE_TYPE.TEXT && item.content) {
    (data as Partial<TextNodeData>).content = textToHtml(item.content);
    (data as Partial<TextNodeData>).plainText = item.content;
  }
  if (item.kind === NODE_TYPE.IMAGE && item.prompt) {
    (data as { genSettings: ImageGenSettings }).genSettings = {
      ...(node.data as { genSettings: ImageGenSettings }).genSettings,
      prompt: item.prompt,
    };
  }
  if (item.kind === NODE_TYPE.VIDEO && item.prompt) {
    (data as { genSettings: VideoGenSettings }).genSettings = {
      ...(node.data as { genSettings: VideoGenSettings }).genSettings,
      prompt: item.prompt,
    };
  }
  if (item.kind === NODE_TYPE.AUDIO && item.prompt) {
    // 音频节点数据形状未定义 genSettings，预填 prompt 供生成面板读取
    (data as { genSettings?: { prompt: string } }).genSettings = {
      ...((data as { genSettings?: { prompt: string } }).genSettings ?? {}),
      prompt: item.prompt,
    };
  }
  return { ...node, data } as AnyNode;
}

// ── 各工具实现 ──

interface ToolArgs {
  [key: string]: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** create_node：批量创建节点（≤6），支持 content/prompt/title 预填、params 生成参数与 connectTo 连线 */
function execCreateNode(args: ToolArgs): { content: string; mutated: boolean } {
  const items = Array.isArray(args.nodes) ? args.nodes : [];
  if (items.length === 0) return { content: "未提供 nodes 参数，已忽略。", mutated: false };

  const store = useCanvasStore.getState();
  const created: AnyNode[] = [];
  const batchIdByIndex = new Map<number, string>();
  const anchor = getViewportCenter();
  const lines: string[] = [];
  const degraded: string[] = [];

  for (let i = 0; i < Math.min(items.length, 6); i++) {
    const item = items[i] as Record<string, unknown>;
    // 严格校验 kind：未知值不兜底放行，把可选值回传给模型让其自行纠正
    // （后端 zod 校验失败时只记日志仍原样透传，此处是最后一道防线）
    const rawKind = str(item.kind) ?? "text";
    // 用 includes 而非 in：in 会查原型链，"toString"/"constructor" 之类值会漏过守卫
    if (!(TOOL_NODE_KINDS as readonly string[]).includes(rawKind)) {
      lines.push(`${i + 1}. kind「${rawKind}」不支持（可选：${TOOL_NODE_KINDS.join("/")}），已跳过`);
      continue;
    }
    const kind = KIND_TO_NODE_TYPE[rawKind as ToolNodeKind];
    const node = NODE_FACTORIES[kind]({ x: 0, y: 0 });
    const filled = fillNodeData(node, {
      kind,
      content: str(item.content),
      prompt: str(item.prompt),
      title: str(item.title),
    });
    // params：创建时直接落生成参数，避免「创建后再 update_node」的二次往返
    const rawParams = item.params != null && typeof item.params === "object" && !Array.isArray(item.params)
      ? (item.params as Record<string, unknown>)
      : undefined;
    let paramNote = "";
    if (rawParams && Object.keys(rawParams).length > 0) {
      const [paramPatch, pLines] = applyAgentParams(filled, rawParams);
      if (Object.keys(paramPatch).length > 0) {
        const gs = ((filled.data as { genSettings?: Record<string, unknown> }).genSettings) ?? {};
        (filled.data as { genSettings?: Record<string, unknown> }).genSettings = { ...gs, ...paramPatch };
        // 新节点必然无 src：占位框直接按比例落尺寸（applyRatioToNode 需节点已入 store，此处提前手写）
        const ratio = paramPatch.ratio;
        if (typeof ratio === "string") {
          const size = ratioToNodeSize(ratio);
          if (size) filled.style = { ...(filled.style ?? {}), width: size.width, height: size.height };
        }
        paramNote = `，参数：${Object.entries(paramPatch).map(([k, v]) => `${k}=${String(v)}`).join(", ")}`;
      }
      degraded.push(...pLines);
    }
    // 位置按最终尺寸寻找空位（params 可能已改变占位框尺寸）
    filled.position = findFreePosition(nodeSize(filled), anchor);
    created.push(filled);
    batchIdByIndex.set(i + 1, filled.id);
    const desc = kind === NODE_TYPE.TEXT ? (str(item.content)?.slice(0, 40) ?? "") : (str(item.prompt)?.slice(0, 40) ?? "");
    lines.push(`${i + 1}. ${kind} → id=${filled.id}${desc ? `（${desc}…）` : ""}${paramNote}`);
  }

  if (created.length === 0) return { content: lines.join("\n") || "没有可创建的节点。", mutated: false };

  store.addNodes(created, { skipHistory: true });

  // connectTo：已存在节点 id 或同批次序号（"1" → 本批次第 1 个节点），方向须符合连线规则
  const newEdges = [];
  const skipped: string[] = [];
  for (let i = 0; i < created.length; i++) {
    const item = items[i] as Record<string, unknown> | undefined;
    for (const raw of strArray(item?.connectTo)) {
      const byIndex = batchIdByIndex.get(Number(raw));
      const targetId = byIndex ?? raw;
      if (targetId === created[i].id) continue;
      const targetNode = byIndex
        ? created.find((n) => n.id === targetId)
        : useCanvasStore.getState().nodes.find((n) => n.id === targetId);
      if (!targetNode) {
        skipped.push(raw);
        continue;
      }
      if (!canConnect(created[i].type, targetNode.type)) {
        skipped.push(`${raw}（${created[i].type} → ${targetNode.type} 不符合连线规则）`);
        continue;
      }
      newEdges.push(createEdge(created[i].id, targetId));
    }
  }
  if (newEdges.length > 0) {
    useCanvasStore.getState().setEdges([...useCanvasStore.getState().edges, ...newEdges], { skipHistory: true });
  }

  let content = `已创建 ${created.length} 个节点：\n${lines.join("\n")}`;
  if (degraded.length > 0) content += `\n参数降级说明：\n${degraded.join("\n")}`;
  if (newEdges.length) content += `\n已创建 ${newEdges.length} 条连线。`;
  if (skipped.length) content += `\n以下连线目标不存在，已跳过：${[...new Set(skipped)].join(", ")}`;
  return { content, mutated: true };
}

// ── agent 参数写入校验 ──

/** 节点类型 → 模型参数 capability（与生成面板 findModelParams 取参一致） */
const NODE_PARAM_CAPABILITY: Partial<Record<CanvasNodeType, ModelCapability>> = {
  [NODE_TYPE.IMAGE]: "image",
  [NODE_TYPE.VIDEO]: "video",
};

/** 支持预填 prompt 的节点类型（text/image/video 各自的生成面板都读 genSettings.prompt） */
const PROMPT_NODE_TYPES = new Set<CanvasNodeType>([
  NODE_TYPE.TEXT,
  NODE_TYPE.IMAGE,
  NODE_TYPE.VIDEO,
  NODE_TYPE.AUDIO,
]);

/** 解析 "W:H" 为宽高比数值；"adaptive" 等非比例串返回 null */
function parseRatioValue(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(v);
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
}

/**
 * 校验 agent 传入的 params，返回 [可写入 genSettings 的字段, 给模型的提示行]。
 * 以当前生效模型（与面板同一回退链：modelKey → 最近使用 → 该能力第一个可用）的
 * 字段配置为唯一依据：有 options 的字段只接受合法档位，ratio 不匹配时选宽高比
 * 最接近的档位；无 options 的数值字段按 min/max 收敛；其余直接写入。
 * 校验不可进行（类型不支持 / 无模型 / 无参数配置）时返回空 patch 与说明行。
 */
function applyAgentParams(node: AnyNode, params: Record<string, unknown>): [Record<string, unknown>, string[]] {
  const capability = NODE_PARAM_CAPABILITY[node.type];
  if (!capability) return [{}, ["该节点类型不支持设置生成参数"]];
  const gs = (node.data as { genSettings?: { modelKey?: string } } | undefined)?.genSettings;

  const { providers, findModelParams } = useModelStore.getState();
  const allModels = providers
    .flatMap((c) =>
      c.models
        .filter((m) => m.capabilities?.includes(capability))
        .map((m) => ({ value: `${c.id}/${m.name}`, providerId: c.id, name: m.name })),
    )
    .filter((m, i, arr) => arr.findIndex((x) => x.value === m.value) === i);
  if (allModels.length === 0) return [{}, ["没有可用的生成模型，未设置参数"]];

  const key = (gs?.modelKey && allModels.some((m) => m.value === gs.modelKey) ? gs.modelKey : "")
    || readLastModel(capability, allModels)
    || allModels[0].value;
  const entry = allModels.find((m) => m.value === key) ?? allModels[0];
  const fields = findModelParams(entry.providerId, entry.name, capability)?.fields ?? [];
  if (fields.length === 0) return [{}, [`模型 ${entry.name} 无参数配置，未设置参数`]];

  const patch: Record<string, unknown> = {};
  const lines: string[] = [];
  for (const [name, raw] of Object.entries(params)) {
    const field = fields.find((f) => f.name === name);
    if (!field) {
      lines.push(`参数 ${name}：当前模型不支持，已跳过`);
      continue;
    }
    const options = Array.isArray(field.options) ? field.options : [];
    if (options.length > 0) {
      // 命中选项时写入选项原值（而非 raw）：数字/布尔选项不会被 LLM 的字符串形式污染
      const matched = options.find((o) => String(o) === String(raw));
      if (matched !== undefined) {
        patch[name] = matched;
        continue;
      }
      // ratio 特例：不匹配时选宽高比最接近的档位（对数距离保证 16:9 的近邻是 9:21 而非 1:1）
      if (name === "ratio" && typeof raw === "string") {
        const target = parseRatioValue(raw);
        const candidates = options
          .map((o) => ({ opt: String(o), r: typeof o === "string" ? parseRatioValue(o) : null }))
          .filter((x): x is { opt: string; r: number } => x.r !== null);
        const hit = target !== null && candidates.length > 0
          ? candidates.reduce((best, x) =>
              Math.abs(Math.log(x.r / target)) < Math.abs(Math.log(best.r / target)) ? x : best)
          : null;
        if (hit) {
          patch[name] = hit.opt;
          lines.push(`参数 ratio：${raw} 不支持，已选最接近的 ${hit.opt}`);
          continue;
        }
      }
      const fallback = field.default != null && options.some((o) => String(o) === String(field.default))
        ? field.default
        : options[0];
      patch[name] = fallback;
      lines.push(`参数 ${name}：值 ${String(raw)} 不支持（可选：${options.join("/")}），已用 ${String(fallback)}`);
      continue;
    }
    // 无 options 的字段按控件类型收敛：switch 收敛为布尔，slider/number 收敛为数字并夹取范围
    // （LLM 输出是系统边界，字符串 "8"/"true" 必须在写入前转为面板/后端期望的类型）
    if (field.type === "switch") {
      const b = raw === true || raw === 1 || raw === "1" || raw === "true"
        ? true
        : raw === false || raw === 0 || raw === "0" || raw === "false" ? false : null;
      if (b === null) {
        lines.push(`参数 ${name}：需要布尔值（true/false），已跳过`);
        continue;
      }
      patch[name] = b;
      continue;
    }
    if (field.type === "slider" || field.type === "number") {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n)) {
        lines.push(`参数 ${name}：需要数字，已跳过`);
        continue;
      }
      if (field.min == null && field.max == null) {
        patch[name] = n;
        continue;
      }
      const clamped = Math.min(Math.max(n, field.min ?? -Infinity), field.max ?? Infinity);
      patch[name] = clamped;
      if (clamped !== n) lines.push(`参数 ${name}：已收敛到 ${clamped}（范围 ${field.min ?? "-∞"}~${field.max ?? "∞"}）`);
      continue;
    }
    // 选项缺失的 segmented/select 属配置异常：仅放行原始类型，对象/数组等一律跳过
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      lines.push(`参数 ${name}：不支持的值类型，已跳过`);
      continue;
    }
    patch[name] = raw;
  }
  return [patch, lines];
}

/** update_node：更新文本正文 / 生成提示词 / 标题 / 生成参数 */
function execUpdateNode(args: ToolArgs): { content: string; mutated: boolean } {
  const nodeId = str(args.nodeId);
  if (!nodeId) return { content: "缺少 nodeId。", mutated: false };

  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return { content: `节点 ${nodeId} 不存在。可从画布状态里查看现有节点 id。`, mutated: false };

  const patch: Record<string, unknown> = {};
  const lines: string[] = [];
  const content = str(args.content);
  const prompt = str(args.prompt);
  // title 与其他字段不同：空字符串是合法值（清除标题），不能经 str() 的非空过滤丢弃
  const title = typeof args.title === "string" ? args.title.trim() : undefined;
  const params = args.params != null && typeof args.params === "object" && !Array.isArray(args.params)
    ? (args.params as Record<string, unknown>)
    : undefined;

  if (title !== undefined) patch.label = title;
  if (content && node.type === NODE_TYPE.TEXT) {
    patch.content = textToHtml(content);
    patch.plainText = content;
  } else if (content) {
    lines.push("content 仅对 text 节点生效，已忽略");
  }

  // prompt 与 params 合并写 genSettings（单次 updateNodeData，保持与面板一致的受控写入）
  const gsBase = ((node.data as { genSettings?: Record<string, unknown> } | undefined)?.genSettings) ?? {};
  const gsPatch: Record<string, unknown> = {};
  if (prompt) {
    if (PROMPT_NODE_TYPES.has(node.type)) gsPatch.prompt = prompt;
    else lines.push("该节点类型不支持设置提示词，已忽略");
  }
  let paramLines: string[] = [];
  if (params && Object.keys(params).length > 0) {
    const [paramPatch, pLines] = applyAgentParams(node, params);
    if (Object.keys(paramPatch).length > 0) {
      Object.assign(gsPatch, paramPatch);
      const written = Object.entries(paramPatch).map(([k, v]) => `${k}=${String(v)}`);
      paramLines = [`参数已写入：${written.join(", ")}`, ...pLines];
      const ratio = paramPatch.ratio;
      if (typeof ratio === "string") applyRatioToNode(nodeId, ratio); // 空节点占位框跟随比例（与面板一致）
    } else {
      paramLines = pLines;
    }
  }
  if (Object.keys(gsPatch).length > 0) patch.genSettings = { ...gsBase, ...gsPatch };

  const allLines = [...lines, ...paramLines];
  if (Object.keys(patch).length === 0) {
    return {
      content: `没有可应用的更新（text 节点用 content，生成节点用 prompt，参数用 params）。${allLines.length > 0 ? `\n${allLines.join("\n")}` : ""}`,
      mutated: false,
    };
  }

  useCanvasStore.getState().updateNodeData(nodeId, patch, undefined, { skipHistory: true });
  let result = `已更新节点 ${nodeId}。`;
  if (allLines.length > 0) result += `\n${allLines.join("\n")}`;
  return { content: result, mutated: true };
}

/** delete_nodes：删除节点（级联清边） */
function execDeleteNodes(args: ToolArgs): { content: string; mutated: boolean } {
  const ids = strArray(args.nodeIds);
  if (ids.length === 0) return { content: "未提供 nodeIds。", mutated: false };

  const existing = useCanvasStore.getState().nodes;
  const found = ids.filter((id) => existing.some((n) => n.id === id));
  const missing = ids.filter((id) => !found.includes(id));
  if (found.length === 0) return { content: `所有节点都不存在：${ids.join(", ")}`, mutated: false };

  useCanvasStore.getState().removeNodes(found, { skipHistory: true });
  let content = `已删除 ${found.length} 个节点。`;
  if (missing.length) content += `\n以下 id 不存在，已跳过：${missing.join(", ")}`;
  return { content, mutated: true };
}

/** connect_nodes：在已有节点间连线 */
function execConnectNodes(args: ToolArgs): { content: string; mutated: boolean } {
  const items = Array.isArray(args.edges) ? args.edges : [];
  if (items.length === 0) return { content: "未提供 edges。", mutated: false };

  const state = useCanvasStore.getState();
  const newEdges = [];
  const errors: string[] = [];
  for (const raw of items) {
    const e = raw as Record<string, unknown>;
    const source = str(e.source);
    const target = str(e.target);
    if (!source || !target) { errors.push("缺少 source/target"); continue; }
    const sourceNode = state.nodes.find((n) => n.id === source);
    const targetNode = state.nodes.find((n) => n.id === target);
    if (!sourceNode) { errors.push(`source ${source} 不存在`); continue; }
    if (!targetNode) { errors.push(`target ${target} 不存在`); continue; }
    if (source === target) { errors.push("不能连接节点自身"); continue; }
    if (state.edges.some((x) => x.source === source && x.target === target)) { errors.push(`${source} → ${target} 已有连线`); continue; }
    // 与画布交互（isValidConnection）同一套规则：连线方向即数据流向
    if (!canConnect(sourceNode.type, targetNode.type)) {
      const allowed = VALID_CONNECTION_OUTPUTS[sourceNode.type ?? ""] ?? [];
      errors.push(`${source} → ${target} 不符合连线规则（${sourceNode.type} 可连出：${allowed.join("/")}）`);
      continue;
    }
    newEdges.push(createEdge(source, target));
  }
  if (newEdges.length > 0) {
    useCanvasStore.getState().setEdges([...useCanvasStore.getState().edges, ...newEdges], { skipHistory: true });
  }
  let content = newEdges.length ? `已创建 ${newEdges.length} 条连线。` : "没有可创建的连线。";
  if (errors.length) content += `\n跳过：${errors.join("；")}`;
  return { content, mutated: newEdges.length > 0 };
}

/** move_node：移动节点到坐标 / 视口中心 / 参照节点旁 */
function execMoveNode(args: ToolArgs): { content: string; mutated: boolean } {
  const nodeId = str(args.nodeId);
  if (!nodeId) return { content: "缺少 nodeId。", mutated: false };

  const nodes = useCanvasStore.getState().nodes;
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return { content: `节点 ${nodeId} 不存在。`, mutated: false };

  const size = nodeSize(node);
  const alignTo = str(args.alignTo);
  let target: { x: number; y: number } | null = null;

  const x = num(args.x);
  const y = num(args.y);
  if (x != null || y != null) {
    target = { x: x ?? node.position.x, y: y ?? node.position.y };
  } else if (alignTo === "center") {
    const c = getViewportCenter();
    target = { x: c.x - size.width / 2, y: c.y - size.height / 2 };
  } else if (alignTo) {
    const ref = nodes.find((n) => n.id === alignTo);
    if (!ref) return { content: `对齐目标节点 ${alignTo} 不存在。`, mutated: false };
    const rs = nodeSize(ref);
    target = { x: ref.position.x + rs.width + 60, y: ref.position.y };
  }

  if (!target) return { content: "请提供 x/y 或 alignTo。", mutated: false };

  useCanvasStore.getState().setNodes(
    nodes.map((n) => (n.id === nodeId ? { ...n, position: target! } : n)),
  );
  markDirtyImmediate();
  return { content: `已移动节点 ${nodeId} 到 (${Math.round(target.x)}, ${Math.round(target.y)})。`, mutated: true };
}

/** arrange_canvas：整理布局（并入 agent 回合的一次撤销，不自压快照） */
function execArrangeCanvas(): { content: string; mutated: boolean } {
  const rt = getCanvasAgentRuntime();
  if (!rt) return { content: "画布尚未就绪，无法整理。", mutated: false };
  const moved = rt.tidyCanvas({ skipHistory: true });
  return moved
    ? { content: "已整理画布布局。", mutated: true }
    : { content: "画布布局已经整齐，无需整理。", mutated: false };
}

/** set_viewport：聚焦节点或跳转坐标 */
function execSetViewport(args: ToolArgs): { content: string; mutated: boolean } {
  const rt = getCanvasAgentRuntime();
  if (!rt) return { content: "画布尚未就绪。", mutated: false };

  const nodeId = str(args.nodeId);
  if (nodeId) {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    if (!node) return { content: `节点 ${nodeId} 不存在。`, mutated: false };
    rt.focusNode(node);
    return { content: `视口已聚焦到节点 ${nodeId}。`, mutated: false };
  }

  const x = num(args.x);
  const y = num(args.y);
  if (x != null && y != null) {
    rt.setCenter(x, y, num(args.zoom));
    return { content: `视口已移动到 (${Math.round(x)}, ${Math.round(y)})。`, mutated: false };
  }
  return { content: "请提供 nodeId 或 x/y。", mutated: false };
}

/** select_nodes：选中节点，可选聚焦 */
function execSelectNodes(args: ToolArgs): { content: string; mutated: boolean } {
  const ids = strArray(args.nodeIds);
  if (ids.length === 0) return { content: "未提供 nodeIds。", mutated: false };

  const idSet = new Set(ids);
  const nodes = useCanvasStore.getState().nodes;
  const found = ids.filter((id) => nodes.some((n) => n.id === id));
  if (found.length === 0) return { content: `所有节点都不存在：${ids.join(", ")}`, mutated: false };

  useCanvasStore.getState().setNodes(
    nodes.map((n) => ({ ...n, selected: idSet.has(n.id) })),
  );
  markDirtyImmediate();

  if (args.focus === true) {
    getCanvasAgentRuntime()?.focusNodes(found);
  }
  return { content: `已选中 ${found.length} 个节点。`, mutated: false };
}

/** 分发执行一个工具调用 */
export function executeCanvasToolCall(call: AgentToolCall): AgentToolResult {
  let out: { content: string; mutated: boolean };
  try {
    switch (call.name) {
      case "create_node": out = execCreateNode(call.args); break;
      case "update_node": out = execUpdateNode(call.args); break;
      case "delete_nodes": out = execDeleteNodes(call.args); break;
      case "connect_nodes": out = execConnectNodes(call.args); break;
      case "move_node": out = execMoveNode(call.args); break;
      case "arrange_canvas": out = execArrangeCanvas(); break;
      case "set_viewport": out = execSetViewport(call.args); break;
      case "select_nodes": out = execSelectNodes(call.args); break;
      default:
        out = { content: `工具「${call.name}」不支持。`, mutated: false };
    }
  } catch (err) {
    out = { content: `工具执行出错：${String(err)}`, mutated: false };
  }
  return { toolCallId: call.id, content: out.content, mutated: out.mutated };
}

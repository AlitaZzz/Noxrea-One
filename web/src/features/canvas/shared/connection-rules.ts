/**
 * 连接合法性判定：统一「一次连接松手会不会产生新边」的口径。
 *
 * 建边本身只认 batchConnect 的去重（重复对静默跳过），这里解决的是判定与反馈：
 * isValidConnection（轨道磁吸）、handleConnectEnd（松手落点判定）、ConnectionFlowLine
 * （节点本体悬停反馈）三处共用本模块，保证「拖拽中看到的反馈」与「松手后的实际
 * 结果」一致——包括多选扇出、类型校验、自连与已连去重。
 *
 * 可迠除类型外还受节点能力约束：上传来源（source === "upload"）的图片/视频是
 * 纯素材，不渲染输入轨、不能作为连线目标（acceptsInput）。这条能力规则是节点
 * 组件渲染输入轨的同一判定（ImageNode / VideoNode 左轨），轨道渲染与连线判定
 * 共用单一实现，不会出现「反馈亮绿灯却建不出边」或反向的漏网。
 *
 * 多选扇出语义：发起端节点处于多选集合（≥2 非组节点）中且对端不在集合内时，
 * 扩展为「所有选中节点 ↔ 对端」。类型校验是全有或全无：任一选中节点与对端
 * 类型不可连则整体拒绝（与创建菜单「全部参与节点兼容才启用」同口径），不做
 * 兼容子集的部分建边；已连的对不影响整体（A→C 已存在、B→C 可连仍放行）。
 *
 * 批量 Handle（框选外框输出 / 组节点双向轨道）不经过 xyflow 连线系统，直接以
 * 显式参与集调用 buildFanoutPairs / buildFanInPairs + pairsWouldCreate
 * （见 use-batch-connect-drag）。
 */
import type { AnyNode } from "@/features/canvas/types";
import { canConnect, NODE_TYPE } from "@/lib/constants";

/** 判定所需的最小画布状态（结构化入参，便于纯函数测试） */
export interface ConnectionRuleState {
  nodes: AnyNode[];
  edges: ReadonlyArray<{ source: string; target: string }>;
}

/**
 * 节点能否作为连线目标：上传来源的图片/视频是纯素材（无输入，只能作源）。
 * 这是节点能力规则（输入轨是否存在）的唯一口径，连线判定与节点组件的
 * 输入轨渲染共用本函数。
 */
export function acceptsInput(type: string | undefined, source: string | undefined): boolean {
  if (type !== NODE_TYPE.IMAGE && type !== NODE_TYPE.VIDEO) return true;
  return source !== "upload";
}

/** acceptsInput 的节点形态便捷封装（连线判定路径用） */
export function nodeAcceptsInput(node: AnyNode): boolean {
  return acceptsInput(node.type, (node.data as { source?: string } | undefined)?.source);
}

/**
 * 批量扇出（输出方向）：参与集 → target 的全部候选对。
 * target 须可作连线目标（nodeAcceptsInput）；类型校验全有或全无——任一参与
 * 节点与 target 类型不可连即整体返回空；
 * target 在参与集内（拖回选区 / 拖到自己组成员）同样返回空（取消语义）；
 * 不查已存在连线（去重由建边时统一处理）。
 */
export function buildFanoutPairs(
  participants: AnyNode[],
  target: AnyNode
): { source: string; target: string }[] {
  if (participants.length === 0) return [];
  if (participants.some((p) => p.id === target.id)) return [];
  if (!nodeAcceptsInput(target)) return [];
  if (!participants.every((p) => canConnect(p.type, target.type))) return [];
  return participants.map((p) => ({ source: p.id, target: target.id }));
}

/**
 * 批量扇入（输入方向）：source → 参与集的全部候选对，是 buildFanoutPairs 的镜像。
 * 同样全有或全无——任一参与节点不可作连线目标或与 source 类型不可连即整体返回空；
 * source 在参与集内（拖回自己组成员）返回空（取消语义）；不查已存在连线。
 */
export function buildFanInPairs(
  source: AnyNode,
  participants: AnyNode[]
): { source: string; target: string }[] {
  if (participants.length === 0) return [];
  if (participants.some((p) => p.id === source.id)) return [];
  if (!participants.every((p) => nodeAcceptsInput(p) && canConnect(source.type, p.type))) return [];
  return participants.map((p) => ({ source: source.id, target: p.id }));
}

/**
 * 计算一次 src → tgt 连接在多选扇出语义下的全部候选对。
 * 排除自连；对端须可作连线目标（nodeAcceptsInput）；类型校验为全有或全无——
 * 扇出时任一选中节点与对端不可连即返回空
 * （整体拒绝），不做兼容子集的部分建边；不查已存在连线（去重由建边时统一处理）。
 */
export function buildConnectionPairs(
  srcId: string,
  tgtId: string,
  nodes: AnyNode[]
): { source: string; target: string }[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const src = nodeById.get(srcId);
  const tgt = nodeById.get(tgtId);
  if (!src || !tgt) return [];

  // 多选扇出：拖线起点/终点在多选集合（≥2 非组节点）中时，
  // 扩展为「所有选中节点 ↔ 对端节点」的批量连线，任一类型不可连则整体拒绝
  const selected = nodes.filter((n) => n.selected && n.type !== NODE_TYPE.GROUP);
  const inSelection = (n: AnyNode) => selected.some((s) => s.id === n.id);
  const pairs: { source: string; target: string }[] = [];
  if (selected.length > 1 && inSelection(src) && !inSelection(tgt)) {
    return buildFanoutPairs(selected, tgt);
  } else if (selected.length > 1 && inSelection(tgt) && !inSelection(src)) {
    if (!selected.every((t) => nodeAcceptsInput(t) && canConnect(src.type, t.type))) return [];
    for (const t of selected) pairs.push({ source: src.id, target: t.id });
  } else if (src.id !== tgt.id && nodeAcceptsInput(tgt) && canConnect(src.type, tgt.type)) {
    pairs.push({ source: src.id, target: tgt.id });
  }
  return pairs;
}

/**
 * 这批候选对是否会实际产生新边：去掉已存在连线后仍有剩余。
 * 已连（全部重复）、类型不可连、自连、target 在参与集内都产生空对集返回
 * false——反馈据此显示 blocked，松手后静默取消，不会出现「显示可连却建不出
 * 边」或「重复建边」的情况。
 */
export function pairsWouldCreate(
  pairs: ReadonlyArray<{ source: string; target: string }>,
  edges: ReadonlyArray<{ source: string; target: string }>
): boolean {
  const existing = new Set(edges.map((e) => `${e.source}->${e.target}`));
  return pairs.some((p) => !existing.has(`${p.source}->${p.target}`));
}

/** 多选拖线口径的「会产生新边」判定（候选对由选中集派生） */
export function connectionWouldCreate(srcId: string, tgtId: string, state: ConnectionRuleState): boolean {
  return pairsWouldCreate(buildConnectionPairs(srcId, tgtId, state.nodes), state.edges);
}

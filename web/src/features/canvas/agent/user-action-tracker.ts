/**
 * 画布用户操作感知（移植 tldraw AgentUserActionTracker 的 diff 思路）。
 *
 * 不记语义动作，只记节点/连线级 diff：订阅 canvas-store 的每次变更，
 * 增量合并进待发送缓冲（拖拽逐帧天然合并为首→尾一条，创建后删除自动抵消）。
 * agent 发消息时 drain() 取走全部待报变更并清空，历史天然有界。
 *
 * 防双计：agent 执行工具（beginAgentActing）与程序化写回（beginSuppress：
 * 生成结果回填 / 上传 / undo / 项目恢复）期间不记录——这些变更要么属于
 * agent 自己，要么不属于"用户操作"，模型可从画布状态快照里看到最终结果。
 *
 * 选择状态（selected）不进动作历史：选择不是记录变更，发送时通过
 * serializeCanvasState 的 selection 字段实时读取（与 tldraw 一致）。
 */
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

/** 动作摘要与变更字段值的最大长度 */
const SUMMARY_MAX = 60;

interface NodeSnapshot {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  content: string;
  prompt: string;
  hasSrc: boolean;
}

interface NodeEntry {
  status: "added" | "updated";
  before?: NodeSnapshot;
  after: NodeSnapshot;
}

export interface UserActionsPayload {
  added: Array<{ id: string; type: string; summary?: string }>;
  removed: Array<{ id: string; type: string; summary?: string }>;
  updated: Array<{ id: string; type: string; changes: Record<string, unknown> }>;
  edges: {
    added: Array<{ source: string; target: string }>;
    removed: Array<{ source: string; target: string }>;
  };
}

const entries = new Map<string, NodeEntry>();
const removedBuffer = new Map<string, NodeSnapshot>();
/** 连线窗口内净变更：before/after 存在性（与节点一致的 squash 语义，删→加→删净值为零） */
interface EdgeEntry {
  source: string;
  target: string;
  before: boolean;
  after: boolean;
}
const edgeEntries = new Map<string, EdgeEntry>();

// 门控：agentActing = agent 执行工具期间；suppress = 程序化写回（生成回填/上传/撤销/项目恢复）。
// 两者都是可嵌套计数，try/finally 配对使用
let agentActing = 0;
let suppress = 0;

export function beginAgentActing(): void {
  agentActing += 1;
}
export function endAgentActing(): void {
  agentActing = Math.max(0, agentActing - 1);
}
export function beginSuppress(): void {
  suppress += 1;
}
export function endSuppress(): void {
  suppress = Math.max(0, suppress - 1);
}

/** 抑制期间执行 fn（程序化写回用），try/finally 保证计数配对 */
export function runSuppressed<T>(fn: () => T): T {
  beginSuppress();
  try {
    return fn();
  } finally {
    endSuppress();
  }
}

function truncate(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > SUMMARY_MAX ? t.slice(0, SUMMARY_MAX) + "…" : t;
}

/** 提取动作历史关心的紧凑快照（刻意不含 selected / measured / 瞬时状态） */
function snapshotNode(n: AnyNode): NodeSnapshot {
  const data = n.data as Record<string, unknown>;
  return {
    id: n.id,
    type: n.type ?? "unknown",
    x: Math.round(n.position.x),
    y: Math.round(n.position.y),
    w: Math.round((n.style?.width as number) ?? 0),
    h: Math.round((n.style?.height as number) ?? 0),
    title: typeof data.label === "string" ? data.label : "",
    content: typeof data.plainText === "string" ? data.plainText : "",
    prompt:
      typeof (data.genSettings as { prompt?: unknown } | undefined)?.prompt === "string"
        ? ((data.genSettings as { prompt: string }).prompt)
        : "",
    hasSrc: typeof data.src === "string" && data.src !== "",
  };
}

function sameSnapshot(a: NodeSnapshot, b: NodeSnapshot): boolean {
  return (
    a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h &&
    a.title === b.title && a.content === b.content &&
    a.prompt === b.prompt && a.hasSrc === b.hasSrc
  );
}

function summaryOf(s: NodeSnapshot): string | undefined {
  const raw = s.title || s.content || s.prompt;
  return raw ? truncate(raw) : undefined;
}

/** 字段级变更（只含真正变化的字段，from/to 摘要化） */
function diffChanges(before: NodeSnapshot, after: NodeSnapshot): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (before.x !== after.x || before.y !== after.y) {
    changes.position = { from: [before.x, before.y], to: [after.x, after.y] };
  }
  if (before.w !== after.w || before.h !== after.h) {
    changes.size = { from: [before.w, before.h], to: [after.w, after.h] };
  }
  if (before.title !== after.title) changes.title = { from: truncate(before.title), to: truncate(after.title) };
  if (before.content !== after.content) changes.content = { from: truncate(before.content), to: truncate(after.content) };
  if (before.prompt !== after.prompt) changes.prompt = { from: truncate(before.prompt), to: truncate(after.prompt) };
  if (!before.hasSrc && after.hasSrc) changes.srcSet = true;
  return changes;
}

function trackNodes(prevNodes: AnyNode[], nextNodes: AnyNode[]): void {
  const prevById = new Map(prevNodes.map((n) => [n.id, n]));
  const nextById = new Map(nextNodes.map((n) => [n.id, n]));

  for (const [id, next] of nextById) {
    const prev = prevById.get(id);
    if (!prev) {
      // 新出现：若是本窗口内刚删掉的（删除又重加），抵消删除记为新增
      removedBuffer.delete(id);
      if (!entries.has(id)) entries.set(id, { status: "added", after: snapshotNode(next) });
      continue;
    }
    const prevSnap = snapshotNode(prev);
    const nextSnap = snapshotNode(next);
    const entry = entries.get(id);
    if (sameSnapshot(prevSnap, nextSnap)) {
      // 无净变化（如仅 selected 翻转）：若已有条目，把 after 拉回当前值，
      // 改了又改回原样的节点在 drain 时会被 before==after 过滤掉
      if (entry) {
        entry.after = nextSnap;
        if (entry.before && sameSnapshot(entry.before, entry.after)) entries.delete(id);
      }
      continue;
    }
    if (entry) {
      entry.after = nextSnap;
    } else {
      entries.set(id, { status: "updated", before: prevSnap, after: nextSnap });
    }
  }

  for (const [id, prev] of prevById) {
    if (nextById.has(id)) continue;
    // 消失：本窗口内新增后删除 → 整体抵消；否则记删除（此前的更新条目一并作废，
    // 净效果就是"节点没了"）
    const entry = entries.get(id);
    if (entry?.status === "added") {
      entries.delete(id);
    } else {
      entries.delete(id);
      removedBuffer.set(id, snapshotNode(prev));
    }
  }
}

function trackEdges(prevEdges: Array<{ source: string; target: string }>, nextEdges: Array<{ source: string; target: string }>): void {
  const key = (e: { source: string; target: string }) => `${e.source}->${e.target}`;
  const prevByKey = new Map(prevEdges.map((e) => [key(e), e]));
  const nextByKey = new Map(nextEdges.map((e) => [key(e), e]));

  for (const [k, next] of nextByKey) {
    if (prevByKey.has(k)) continue;
    const entry = edgeEntries.get(k);
    if (entry) entry.after = true;
    else edgeEntries.set(k, { source: next.source, target: next.target, before: false, after: true });
  }
  for (const [k, prev] of prevByKey) {
    if (nextByKey.has(k)) continue;
    const entry = edgeEntries.get(k);
    if (entry) {
      entry.after = false;
      // 净值归零（如删后又加回原样）：条目整体移除
      if (!entry.before) edgeEntries.delete(k);
    } else {
      edgeEntries.set(k, { source: prev.source, target: prev.target, before: true, after: false });
    }
  }
  // 仍然存在的连线：把 after 拉回当前存在状态，处理「删了又加回」的回退
  for (const k of nextByKey.keys()) {
    if (!prevByKey.has(k)) continue;
    const entry = edgeEntries.get(k);
    if (entry) {
      entry.after = true;
      if (entry.before) edgeEntries.delete(k);
    }
  }
}

function onStoreChange(
  state: { nodes: AnyNode[]; edges: Array<{ source: string; target: string }> },
  prevState: { nodes: AnyNode[]; edges: Array<{ source: string; target: string }> },
): void {
  if (agentActing > 0 || suppress > 0) return;
  if (state.nodes !== prevState.nodes) trackNodes(prevState.nodes, state.nodes);
  if (state.edges !== prevState.edges) trackEdges(prevState.edges, state.edges);
}

useCanvasStore.subscribe(onStoreChange);

/** 取走自上次 drain 以来的全部变更并清空缓冲；无变更返回 null */
export function drainUserActions(): UserActionsPayload | null {
  const added: UserActionsPayload["added"] = [];
  const removed: UserActionsPayload["removed"] = [];
  const updated: UserActionsPayload["updated"] = [];

  for (const entry of entries.values()) {
    if (entry.status === "added") {
      const item: { id: string; type: string; summary?: string } = {
        id: entry.after.id,
        type: entry.after.type,
      };
      const summary = summaryOf(entry.after);
      if (summary) item.summary = summary;
      added.push(item);
    } else if (entry.before) {
      const changes = diffChanges(entry.before, entry.after);
      if (Object.keys(changes).length === 0) continue;
      updated.push({ id: entry.after.id, type: entry.after.type, changes });
    }
  }
  for (const snap of removedBuffer.values()) {
    const item: { id: string; type: string; summary?: string } = { id: snap.id, type: snap.type };
    const summary = summaryOf(snap);
    if (summary) item.summary = summary;
    removed.push(item);
  }

  const edgesAddedOut: UserActionsPayload["edges"]["added"] = [];
  const edgesRemovedOut: UserActionsPayload["edges"]["removed"] = [];
  for (const e of edgeEntries.values()) {
    if (e.after) edgesAddedOut.push({ source: e.source, target: e.target });
    else edgesRemovedOut.push({ source: e.source, target: e.target });
  }

  const payload: UserActionsPayload = {
    added,
    removed,
    updated,
    edges: {
      added: edgesAddedOut,
      removed: edgesRemovedOut,
    },
  };

  const empty =
    added.length === 0 && removed.length === 0 && updated.length === 0 &&
    edgesAddedOut.length === 0 && edgesRemovedOut.length === 0;

  entries.clear();
  removedBuffer.clear();
  edgeEntries.clear();

  return empty ? null : payload;
}

/** 清空缓冲（不返回内容）：会话切换 / 项目切换时调用 */
export function clearUserActions(): void {
  entries.clear();
  removedBuffer.clear();
  edgeEntries.clear();
}

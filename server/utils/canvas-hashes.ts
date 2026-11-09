/**
 * 托管文件引用的 hash 提取（画布保存链路的唯一实现）。
 * 服务端在 updateProject 保存事务中比较新旧画布引用，决定是否重算 file_refs 账本。
 * hash 提取单点在 shared/url.ts：资产 CRUD 同样用它从引用值定位 file_objects 行。
 *
 * 引用值域 = 存储 key（`{userId}/{hash[:2]}/{hash}{ext}`，严格形态与 hash 提取单点在
 * shared/url.ts）或外部 http(s) URL。托管文件引用入库后一律为 key 形态
 * （specs/storage-reference-key-unification 入库值域规则）；外部 URL 不入引用账本。
 *
 * 账本覆盖面 = 画布数据中直接渲染或使用的托管文件引用字段（字段清单与排除理由见
 * specs/canvas-file-ref-ledger-coverage.md）：
 * - 所有节点 `data.src`（图片 / 视频 / 音频的主媒体引用）；
 * - 图片多结果 `data.multiResultKeys[]`（堆叠卡与展开网格逐张渲染）；
 * - 导演节点 `data.directorState.shots[].ref`（镜头缩略图与「落回画布」的来源）；
 * - 导演实体 `data.directorState.entities[].srcUrl`（含 crowd 的 members 嵌套）。
 *
 * 明确排除：`genSettings.ref*Order` 仅存排序偏好，参考存在性派生自连线且 mergeOrder
 * 会过滤失效项；`upload.previewUrl` 是 blob:/data: 预览；提示词中的「图片N」是纯文本令牌。
 */

import { isRecord } from "@noxrea/shared/object";
import { hashFromStorageKey } from "@noxrea/shared/url";

function pushStringRef(refs: string[], value: unknown): void {
  if (typeof value === "string") refs.push(value);
}

/**
 * 导演实体（含 crowd.members 嵌套）：srcUrl 是角色模型 / 贴图地址。
 * 画布 JSON 由客户端提供且层数不受控，使用显式栈迭代，避免深层嵌套耗尽调用栈。
 */
function collectDirectorEntityRefs(entities: unknown, refs: string[]): void {
  const pending: unknown[] = [entities];
  while (pending.length > 0) {
    const list = pending.pop();
    if (!Array.isArray(list)) continue;
    for (const entity of list) {
      if (!isRecord(entity)) continue;
      pushStringRef(refs, entity.srcUrl);
      if (Array.isArray(entity.members)) pending.push(entity.members);
    }
  }
}

/** 收集单个节点 data 中的托管文件引用候选（去重前）。 */
function collectNodeRefs(data: Record<string, unknown>, refs: string[]): void {
  pushStringRef(refs, data.src);

  if (Array.isArray(data.multiResultKeys)) {
    for (const ref of data.multiResultKeys) pushStringRef(refs, ref);
  }

  const director = data.directorState;
  if (!isRecord(director)) return;
  if (Array.isArray(director.shots)) {
    for (const shot of director.shots) {
      if (isRecord(shot)) pushStringRef(refs, shot.ref);
    }
  }
  collectDirectorEntityRefs(director.entities, refs);
}

/**
 * 从画布节点数组提取文件 hash 数量。
 * 计数粒度是节点：同一节点内的同一文件只计一次，不同节点分别累加。
 */
export function extractHashCountsFromCanvas(
  canvasData: Record<string, unknown>,
): Map<string, number> {
  const nodes = Array.isArray(canvasData.nodes) ? canvasData.nodes : [];
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const data = node.data;
    if (!isRecord(data)) continue;
    const refs: string[] = [];
    collectNodeRefs(data, refs);
    const seen = new Set<string>();
    for (const ref of refs) {
      const hash = hashFromStorageKey(ref);
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }
  }
  return counts;
}

/** 两份引用计数是否一致；一致时保存无需重算账本（布局保存不触发账本写入）。 */
export function hashCountsEqual(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [hash, count] of a) {
    if (b.get(hash) !== count) return false;
  }
  return true;
}

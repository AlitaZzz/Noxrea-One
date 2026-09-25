/**
 * 离线草稿存储（IndexedDB 封装，基于 idb）。
 *
 * 职责：把「尚未落库的画布改动」持久化到浏览器本地，离线 / 弱网刷新不丢；
 * 进入画布时按代际（rev）判断草稿是否比服务端新，决定是否提示恢复。
 *
 * 仅存画布结构（nodes / edges / 视口等），不含 /api/files 的文件资源
 * （文件离线缓存属 PWA + Service Worker 范畴，另议）。
 *
 * 代际语义：rev = 写入草稿时的「服务端 revision + 在途保存数 + 1」，
 * 即本草稿若落库将产生的版本号。保存成功达到某版本后，rev 不超过该版本的
 * 草稿即为陈旧（含 put/clear 竞态留下的幽灵记录），删除或忽略均安全。
 * 历史格式（无 rev 字段）视为陈旧，永不提示恢复。
 */
import { type DBSchema, type IDBPDatabase, openDB } from "idb";

import type { AnyEdge, BackgroundType, ViewportState } from "@/features/canvas/types";
import type { AnyNode } from "@/features/canvas/types";

/** 草稿的画布数据，字段与 restoreFromProject 入参一致，便于直接恢复 */
export interface DraftCanvasData {
  nodes: AnyNode[];
  edges: AnyEdge[];
  viewport: ViewportState;
  background: BackgroundType;
  minimapVisible: boolean;
  snapToGrid: boolean;
  agentModel?: string;
}

export interface DraftRecord {
  projectId: string;
  /** 代际：本草稿若落库将产生的服务端 revision；rev <= 服务端当前 revision 即陈旧 */
  rev: number;
  canvasData: DraftCanvasData;
}

/** 恢复判定：草稿代际比服务端新才提示；幽灵记录与旧格式记录（无 rev）一律不提示 */
export function isDraftNewer(draft: DraftRecord | null, serverRevision: number): draft is DraftRecord {
  return !!draft && typeof draft.rev === "number" && draft.rev > serverRevision;
}

interface DraftDB extends DBSchema {
  drafts: {
    key: string;
    value: DraftRecord;
  };
}

const DB_NAME = "noxrea-drafts";
const DB_VERSION = 1;
const STORE = "drafts";

let dbPromise: Promise<IDBPDatabase<DraftDB>> | null = null;

function getDB(): Promise<IDBPDatabase<DraftDB>> {
  if (!dbPromise) {
    dbPromise = openDB<DraftDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "projectId" });
        }
      },
    });
  }
  return dbPromise;
}

/** 写草稿（覆盖同 projectId 的旧草稿）。单事务完成「读旧值 → 条件写入」：
 * 代际只前进不后退，更旧代际的写入被拒绝；并发固化（如切换项目前的固化与
 * 迟到的失败 job 固化）按 IndexedDB 事务创建顺序串行，旧代际不可能回退覆盖 */
export async function saveDraft(projectId: string, rev: number, canvasData: DraftCanvasData): Promise<void> {
  if (typeof window === "undefined") return;
  const db = await getDB();
  const tx = db.transaction(STORE, "readwrite");
  const existing = await tx.objectStore(STORE).get(projectId);
  if (!(existing && typeof existing.rev === "number" && existing.rev > rev)) {
    await tx.objectStore(STORE).put({ projectId, rev, canvasData });
  }
  await tx.done;
}

/** 读草稿，不存在返回 null */
export async function loadDraft(projectId: string): Promise<DraftRecord | null> {
  if (typeof window === "undefined") return null;
  const db = await getDB();
  const record = await db.get(STORE, projectId);
  return record ?? null;
}

/** 清草稿（用户明确恢复 / 丢弃时调用） */
export async function clearDraft(projectId: string): Promise<void> {
  if (typeof window === "undefined") return;
  const db = await getDB();
  await db.delete(STORE, projectId);
}

/**
 * 删除代际不超过 serverRev 的草稿（保存成功后调用）。
 * 较新的草稿保留：其内容包含在途保存之后产生的未落库改动。
 * 同样单事务条件删除：与并发写入按事务顺序串行，不会误删间隙内落下的更新草稿。
 */
export async function clearStaleDraft(projectId: string, serverRev: number): Promise<void> {
  if (typeof window === "undefined") return;
  const db = await getDB();
  const tx = db.transaction(STORE, "readwrite");
  const existing = await tx.objectStore(STORE).get(projectId);
  if (!(existing && typeof existing.rev === "number" && existing.rev > serverRev)) {
    await tx.objectStore(STORE).delete(projectId);
  }
  await tx.done;
}

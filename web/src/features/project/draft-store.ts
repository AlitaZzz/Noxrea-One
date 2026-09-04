/**
 * 离线草稿存储（IndexedDB 封装，基于 idb）。
 *
 * 职责：把「尚未落库的画布改动」持久化到浏览器本地，离线 / 弱网刷新不丢；
 * 恢复在线或下次进入时，若本地草稿比后端更新，由加载流程提示恢复。
 *
 * 仅存画布结构（nodes / edges / 视口等），不含 /api/files 的文件资源
 * （文件离线缓存属 PWA + Service Worker 范畴，另议）。
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import type { AnyEdge, BackgroundType, ThemeMode, ViewportState } from "@/features/canvas/types";
import type { AnyNode } from "@/features/canvas/types";

/** 草稿的画布数据，字段与 restoreFromProject 入参一致，便于直接恢复 */
export interface DraftCanvasData {
  nodes: AnyNode[];
  edges: AnyEdge[];
  viewport: ViewportState;
  background: BackgroundType;
  theme: ThemeMode;
  minimapVisible: boolean;
  snapToGrid: boolean;
  agentModel?: string;
}

export interface DraftRecord {
  projectId: string;
  /** 草稿写入时间戳（ms），用于与后端 updatedAt 比较判断谁更新 */
  updatedAt: number;
  canvasData: DraftCanvasData;
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

/** 写草稿（覆盖同 projectId 的旧草稿） */
export async function saveDraft(projectId: string, canvasData: DraftCanvasData): Promise<void> {
  if (typeof window === "undefined") return;
  const db = await getDB();
  await db.put(STORE, { projectId, updatedAt: Date.now(), canvasData });
}

/** 读草稿，不存在返回 null */
export async function loadDraft(projectId: string): Promise<DraftRecord | null> {
  if (typeof window === "undefined") return null;
  const db = await getDB();
  const record = await db.get(STORE, projectId);
  return record ?? null;
}

/** 清草稿（落库成功后调用） */
export async function clearDraft(projectId: string): Promise<void> {
  if (typeof window === "undefined") return;
  const db = await getDB();
  await db.delete(STORE, projectId);
}

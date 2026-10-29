/**
 * 音频峰值的设备本地缓存（specs/canvas-audio-peaks-cache.md 规则 3）。
 *
 * 主键是存储 key（`{userId}/{hash[:2]}/{hash}{ext}`，内容寻址）：同一 key 的内容恒定，
 * 因此不设 TTL，只按使用时间做条数上限淘汰。与 `noxrea-file-access` 分开建库——描述是
 * 能力凭据（登出清空），峰值是内容派生物（登出保留），混库会把两种清空语义绑死。
 *
 * 任何 IndexedDB 故障（隐私模式、配额、升级失败）都按「无持久化」处理：服务退化为
 * 纯内存缓存，正确性不受影响（规则 3.6）。读取时校验记录形状与主键：IDB 是外部
 * 存储，旧版本、被截断或手工改坏的记录不得进入服务层——那会让 `peaksBytes` 之类的
 * 纯函数抛出，破坏「服务入口永不抛出」的契约；形状不符一律按未命中处理。
 */
import { type DBSchema } from "idb";

import { createCacheDatabase, putAndTrim } from "@/lib/idb-cache";

/** 一条持久化的峰值；`channels` 由结构化克隆原样保存为 `Float32Array` */
export interface PeaksRecord {
  /** 存储 key：与引用值归一化后的缓存键同形（规则 3.1） */
  key: string;
  channels: Float32Array[];
  /** 解码时长（秒），来自 `AudioBuffer.duration` */
  duration: number;
  /** 写入时刻（毫秒） */
  savedAt: number;
  /** 最近使用时刻（毫秒）：LRU 淘汰依据 */
  lastUsedAt: number;
}

interface PeaksDB extends DBSchema {
  peaks: {
    key: string;
    value: PeaksRecord;
    indexes: { "by-used": number };
  };
}

const DB_NAME = "noxrea-audio-peaks";
const DB_VERSION = 1;
const STORE = "peaks";
/** 条数上限：与描述缓存同量级，超出按最近使用时间淘汰最旧的（规则 3.4） */
const ENTRY_LIMIT = 500;

const db = createCacheDatabase<PeaksDB>(DB_NAME, DB_VERSION, (connection) => {
  connection.createObjectStore(STORE, { keyPath: "key" }).createIndex("by-used", "lastUsedAt");
});

/**
 * 读取边界上的形状校验：`channels` 必须是非空的 `Float32Array` 数组、`duration`
 * 必须是有限正数，其余数值字段必须有限。不校验数值范围之外的内容——峰值本身
 * 是否落在 [-1, 1] 由解码产物负责，持久层只保证结构可用。
 */
function isValidRecord(value: unknown): value is PeaksRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PeaksRecord>;
  return (
    typeof record.key === "string"
    && Array.isArray(record.channels)
    && record.channels.length > 0
    && record.channels.every((channel) => channel instanceof Float32Array && channel.length > 0)
    && typeof record.duration === "number"
    && Number.isFinite(record.duration)
    && record.duration > 0
    && typeof record.savedAt === "number"
    && Number.isFinite(record.savedAt)
    && typeof record.lastUsedAt === "number"
    && Number.isFinite(record.lastUsedAt)
  );
}

/**
 * 可用记录：形状正确且主键与请求一致——索引/主键错位的记录不能当成这次请求的命中。
 * 读取与刷新使用时刻共用这一判定：两处对「什么算命中」必须一致。
 */
function isUsableRecord(record: unknown, key: string): record is PeaksRecord {
  return isValidRecord(record) && record.key === key;
}

/** 读取一条峰值；未命中、读取失败与形状不符都返回 null（按无持久化处理） */
export async function readPeaks(key: string): Promise<PeaksRecord | null> {
  const connection = await db();
  if (!connection) return null;
  try {
    const record = await connection.get(STORE, key);
    return isUsableRecord(record, key) ? record : null;
  } catch {
    return null;
  }
}

/** 写入一条峰值（顺带按最近使用时间淘汰超出上限的旧条目） */
export async function writePeaks(record: PeaksRecord): Promise<void> {
  const connection = await db();
  if (!connection) return;
  await putAndTrim(connection, STORE, "by-used", ENTRY_LIMIT, [record]);
}

/** 命中即刷新使用时刻：LRU 按「最近用过」而不是「最近解过」淘汰 */
export async function touchPeaks(key: string, lastUsedAt: number): Promise<void> {
  const connection = await db();
  if (!connection) return;
  try {
    const transaction = connection.transaction(STORE, "readwrite");
    const record = await transaction.store.get(key);
    // 不可用的记录不回写：保留原样，等读取路径按未命中覆盖或淘汰
    if (isUsableRecord(record, key)) {
      await transaction.store.put({ ...record, lastUsedAt });
    }
    await transaction.done;
  } catch {
    // 使用时刻只是淘汰依据，写失败不影响本次命中
  }
}

/**
 * 签名描述的设备本地缓存（specs/storage-signed-direct-delivery.md 规则 3.2）。
 *
 * 只保存 `signed` 且无下载语义的描述：签名 URL 是能力凭据，落盘把可用面从内存
 * 扩大到磁盘（上限仍是 TTL），缓解手段是账号作用域隔离、登出清空与寿命封顶。
 * `stream` 与下载描述不落盘（前者由形态学习直接构造，后者含一次性附件名）。
 *
 * 任何 IndexedDB 故障（隐私模式、配额、结构升级失败）都按「无缓存」处理：
 * 解析层退化为纯内存，正确性不受影响。
 */
import { type DBSchema, type IDBPDatabase,openDB } from "idb";

/** 一条持久化的签名描述；`cacheKey` 与 `scope` 都参与命中判定 */
export interface PersistedSignedDescriptor {
  /** 逻辑键（存储 key + 宽度），同一对象不同档位互不覆盖 */
  cacheKey: string;
  /** 账号作用域（登录用户 id） */
  scope: string;
  url: string;
  /** URL 失效时刻（Unix 秒） */
  expiresAt: number;
  /**
   * 建议重新描述时刻（Unix 秒）；缺省表示服务端未给出，按失效前 60 秒处理
   * （`expiryOf` 的唯一口径）。落盘时不得用 `expiresAt` 填补——那会把「没有建议
   * 时刻」固化成「有效到最后一刻」，跨会话命中就拿不到余量。
   */
  refreshAt?: number;
  /** 写入时刻（毫秒）：LRU 淘汰依据 */
  savedAt: number;
}

interface FileAccessDB extends DBSchema {
  signed: {
    key: string;
    value: PersistedSignedDescriptor;
    indexes: { "by-saved": number };
  };
}

const DB_NAME = "noxrea-file-access";
const DB_VERSION = 1;
const STORE = "signed";
/** 条目上限：描述是缓存而非数据源，超出按写入时间淘汰最旧的 */
const PERSISTED_ENTRY_LIMIT = 500;

let database: Promise<IDBPDatabase<FileAccessDB> | null> | null = null;

function db(): Promise<IDBPDatabase<FileAccessDB> | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  database ??= openDB<FileAccessDB>(DB_NAME, DB_VERSION, {
    upgrade(connection) {
      connection.createObjectStore(STORE, { keyPath: "cacheKey" }).createIndex("by-saved", "savedAt");
    },
  }).catch(() => null);
  return database;
}

/** 读取全部持久化条目（会话开始时一次性加载，命中判定在解析层按作用域与寿命进行） */
export async function readPersistedDescriptors(): Promise<PersistedSignedDescriptor[]> {
  const connection = await db();
  if (!connection) return [];
  try {
    return await connection.getAll(STORE);
  } catch {
    return [];
  }
}

/** 批量写入（顺带按写入时间淘汰超出上限的旧条目） */
export async function writePersistedDescriptors(
  records: readonly PersistedSignedDescriptor[],
): Promise<void> {
  if (records.length === 0) return;
  const connection = await db();
  if (!connection) return;
  try {
    const transaction = connection.transaction(STORE, "readwrite");
    for (const record of records) void transaction.store.put(record);
    await transaction.done;
  } catch {
    // 落盘失败只损失跨会话命中，不影响本次解析
    return;
  }
  await trim(connection);
}

/** 删除指定条目（会话开始时清理已过期或属于其他账号的记录） */
export async function deletePersistedDescriptors(cacheKeys: readonly string[]): Promise<void> {
  if (cacheKeys.length === 0) return;
  const connection = await db();
  if (!connection) return;
  try {
    const transaction = connection.transaction(STORE, "readwrite");
    for (const key of cacheKeys) void transaction.store.delete(key);
    await transaction.done;
  } catch {
    // 清理失败只会让过期条目多留一会儿，不影响正确性
  }
}

/** 清空全部条目（登出 / 切换账号） */
export async function clearPersistedDescriptors(): Promise<void> {
  const connection = await db();
  if (!connection) return;
  try {
    await connection.clear(STORE);
  } catch {
    // 同上：清空失败由作用域校验兜住
  }
}

async function trim(connection: IDBPDatabase<FileAccessDB>): Promise<void> {
  try {
    const excess = (await connection.count(STORE)) - PERSISTED_ENTRY_LIMIT;
    if (excess <= 0) return;
    const transaction = connection.transaction(STORE, "readwrite");
    let removed = 0;
    // savedAt 索引升序：游标从最旧的一条开始
    let cursor = await transaction.store.index("by-saved").openCursor();
    while (cursor && removed < excess) {
      await cursor.delete();
      removed += 1;
      cursor = await cursor.continue();
    }
    await transaction.done;
  } catch {
    // 淘汰失败只是条目多留几条
  }
}

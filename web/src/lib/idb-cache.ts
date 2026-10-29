/**
 * IndexedDB 缓存的公共骨架（specs/canvas-audio-peaks-cache.md 规则 3.6）。
 *
 * 各缓存库只关心自己的库名、版本、store / index 定义与条数上限；「IndexedDB
 * 不可用或打开失败退化为无持久化」与「按索引升序淘汰最旧条目」是同一条规则，
 * 集中在这里，避免每加一个缓存就复制一遍错误处理与游标淘汰。
 */
import type { DBSchema, IDBPDatabase, IndexNames, StoreNames, StoreValue } from "idb";
import { openDB } from "idb";

/**
 * 惰性打开一个缓存库：IndexedDB 不可用或打开失败都缓存 `null`，调用方退化为
 * 无持久化；失败结果同样被缓存，后续调用不再重试。`upgrade` 只在首次创建 /
 * 版本升级时执行。
 */
export function createCacheDatabase<DB extends DBSchema>(
  name: string,
  version: number,
  upgrade: (connection: IDBPDatabase<DB>) => void,
): () => Promise<IDBPDatabase<DB> | null> {
  let database: Promise<IDBPDatabase<DB> | null> | null = null;
  return () => {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    database ??= openDB<DB>(name, version, { upgrade }).catch(() => null);
    return database;
  };
}

/**
 * 按索引升序淘汰最旧条目，直到总数不超过 `limit`。淘汰失败只让条目多留几条，
 * 不向调用方抛出——缓存不是数据源。
 */
async function trimOldestEntries<
  DB extends DBSchema,
  StoreName extends StoreNames<DB>,
  IndexName extends IndexNames<DB, StoreName>,
>(
  connection: IDBPDatabase<DB>,
  store: StoreName,
  index: IndexName,
  limit: number,
): Promise<void> {
  try {
    const excess = (await connection.count(store)) - limit;
    if (excess <= 0) return;
    const transaction = connection.transaction(store, "readwrite");
    let removed = 0;
    // 索引升序：游标从最旧的一条开始
    let cursor = await transaction.store.index(index).openCursor();
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

/**
 * 写入一批记录，再按索引升序淘汰超出上限的旧条目。写入失败只损失跨会话命中，
 * 不向调用方抛出——缓存不是数据源。
 */
export async function putAndTrim<
  DB extends DBSchema,
  StoreName extends StoreNames<DB>,
  IndexName extends IndexNames<DB, StoreName>,
>(
  connection: IDBPDatabase<DB>,
  store: StoreName,
  index: IndexName,
  limit: number,
  records: readonly StoreValue<DB, StoreName>[],
): Promise<void> {
  if (records.length === 0) return;
  try {
    const transaction = connection.transaction(store, "readwrite");
    for (const record of records) void transaction.store.put(record);
    await transaction.done;
  } catch {
    return;
  }
  await trimOldestEntries(connection, store, index, limit);
}

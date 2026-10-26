/**
 * 内存描述缓存（规则 3.2）：只按 `cacheKey` 存取，过期判定与上界都收敛在这里。
 *
 * 写入必须带请求序号：强制刷新与在途去重各自发起请求时可能并发，先发起的旧描述
 * 后返回不得覆盖后发起的新描述（否则重试拿回刚被判定失效的地址）。
 */
import { expiryOf, type FileAccessDescriptor } from "./protocol";

interface CacheEntry {
  descriptor: FileAccessDescriptor;
  /** 写入条目的请求序号：后发起的请求才允许覆盖先发起的 */
  seq: number;
  /** 过期时刻（毫秒）；见 expirationOf */
  expiresAtMs: number;
}

/**
 * 条目上限：过期项只在读取时惰性淘汰，长期会话里不同对象/档位会持续堆积。
 * 超限时先清过期项，再按写入顺序丢最旧——描述只是缓存，丢掉的代价是一次重新描述。
 */
export const MEMORY_ENTRY_LIMIT = 500;

const cache = new Map<string, CacheEntry>();

export function resetCache(): void {
  cache.clear();
}

/**
 * 缓存条目读取（唯一的过期判定点）。默认不就地删除过期项：渲染期探测
 * （`peekMediaAccess`）可能被并发渲染调用，删除是副作用，留给解析路径或会话切换清理。
 */
export function cachedDescriptorOf(
  cacheKey: string,
  { evict }: { evict: boolean },
): FileAccessDescriptor | null {
  const entry = cache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    if (evict) cache.delete(cacheKey);
    return null;
  }
  return entry.descriptor;
}

/** 仅在序号更新时写入；返回是否写入（调用方据此决定是否同步持久化，两处同一定序） */
export function storeIfNewer(
  cacheKey: string,
  seq: number,
  descriptor: FileAccessDescriptor,
): boolean {
  const current = cache.get(cacheKey);
  if (current && current.seq >= seq) return false;
  // Map 覆盖已有 key 不改变插入顺序；先删再插，刷新过的条目才回到「最新写入」队尾，
  // 上界淘汰时不会把刚刷新的描述当成最旧项丢掉。
  cache.delete(cacheKey);
  cache.set(cacheKey, { descriptor, seq, expiresAtMs: expiryOf(descriptor) });
  boundCache();
  return true;
}

/**
 * 缓存上界（写入后调用）：先清已过期项，仍超限则按写入顺序丢最旧。
 * 失效项本就会在读取时被丢弃，这里只是把「不再被读取的失效项」也一并清掉，
 * 保证长期会话的内存占用不随浏览过的对象数无限增长。
 */
function boundCache(): void {
  if (cache.size <= MEMORY_ENTRY_LIMIT) return;
  const now = Date.now();
  for (const [cacheKey, entry] of cache) {
    if (entry.expiresAtMs <= now) cache.delete(cacheKey);
  }
  for (const cacheKey of cache.keys()) {
    if (cache.size <= MEMORY_ENTRY_LIMIT) break;
    cache.delete(cacheKey);
  }
}

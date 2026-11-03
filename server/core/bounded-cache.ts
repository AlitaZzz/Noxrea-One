/**
 * 进程内有界缓存写入。
 *
 * 按内容键累积的缓存必须有上限；超过上限整体清空而不是逐条淘汰——这些缓存的
 * 价值只在于省一次探测或解码，清空后重新计算即可，不会产生错误结果，也无需
 * 维护 LRU 顺序。
 */
export function setBounded<K, V>(cache: Map<K, V>, key: K, value: V, max: number): void {
  if (cache.size >= max) cache.clear();
  cache.set(key, value);
}

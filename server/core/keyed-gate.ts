/**
 * 进程内按 key 的 promise-tail 互斥：同一 key 串行，不同 key 并行。
 *
 * 与数据库锁不同，等待发生在应用进程内，不占用连接池连接；跨进程/实例的互斥
 * 仍必须由数据库锁或分布式锁承担，本闸门只是本进程的排队与连接成本优化。
 *
 * 条目生命周期（与画布项目临界区 RR-03 同一口径）：gate 完成后，仅当条目仍是
 * 自己写入的 tail 时才移除；期间若有新 gate 排队并覆盖条目，说明临界区仍有
 * 排队者，条目归新 tail 清理——身份比对保证绝不误删使用中的队列。
 */
export interface KeyedGate<K> {
  run<T>(key: K, fn: () => Promise<T>): Promise<T>;
  /** 在途 / 待清理的 key 条目数（测试观察口与指标） */
  size(): number;
  clear(): void;
}

export function createKeyedGate<K>(): KeyedGate<K> {
  const tails = new Map<K, Promise<void>>();
  return {
    run<T>(key: K, fn: () => Promise<T>): Promise<T> {
      const tail = tails.get(key) ?? Promise.resolve();
      // 前序 gate 永不 reject（next 已把成败归一为 undefined），两个分支同 fn
      const run = tail.then(fn, fn);
      const next = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, next);
      void next.then(() => {
        if (tails.get(key) === next) tails.delete(key);
      });
      return run;
    },
    size: () => tails.size,
    clear: () => tails.clear(),
  };
}

/**
 * 解析结果变更信号（specs/web-managed-media-hydration.md 2.1）。
 *
 * 外部快照的订阅源：内存缓存写入/重置、持久化载入/重置、stream 形态学习与会话
 * 作用域的变化都经这里通知 React。持久化写入不单独通知——它是缓存条目的设备镜像，
 * 同一次写入已由缓存通知。本模块不依赖 React，避免缓存模块反向依赖渲染层。
 *
 * 通知只表示「可能变了」：订阅方重新取快照，由快照的稳定引用决定是否真正重渲染。
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * 变更版本（每次通知 +1）。`useSyncExternalStore` 的 getSnapshot 必须返回稳定引用，
 * 而 `peekMediaAccess` 每次派生新对象：消费方按「来源 + 版本」缓存派生结果，
 * 版本变化即缓存失效。被丢弃的渲染写入的旧版本条目不会残留，读取时会被版本校验淘汰。
 */
let version = 0;

export function accessChangeVersion(): number {
  return version;
}

export function subscribeAccessChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyAccessChanged(): void {
  version += 1;
  for (const listener of listeners) listener();
}

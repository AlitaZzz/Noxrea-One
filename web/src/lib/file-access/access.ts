/**
 * 同步读取（specs/web-managed-media-hydration.md 2.1）。
 *
 * `peekMediaAccess` 是不触发网络的同步读入口。本模块不保存派生结果：签名地址只
 * 存在于缓存与持久化副本这两份真相里，随各自的会话重置一起失效；快照的引用稳定性
 * 由消费方（`useFileAccessUrl` 的按源冻结）在本地保证。解析层没有独立的派生存储，
 * 会话重置也就不需要额外的清理步骤。
 */
import { cachedDescriptorOf } from "./cache";
import { persistedDescriptorOf } from "./persisted";
import {
  cacheKeyOf,
  type FileAccessDescriptor,
  requestOf,
  type ResolvedMediaAccess,
  splitFragment,
  streamDescriptorOf,
  withFragment,
} from "./protocol";
import { currentScope, isStreamLearned } from "./state";

/** 描述 → 访问结果（唯一映射点）；寿命字段只对 signed 有意义 */
export function accessOf(descriptor: FileAccessDescriptor, fragment: string): ResolvedMediaAccess {
  const url = withFragment(descriptor.url, fragment);
  if (descriptor.delivery === "stream") return { url, delivery: "stream" };
  return {
    url,
    delivery: "signed",
    expiresAt: descriptor.expiresAt,
    ...(descriptor.refreshAt !== undefined ? { refreshAt: descriptor.refreshAt } : {}),
  };
}

/**
 * 同步取已解析结果（不触发网络）：
 * - 外部值 / 非托管值：原样返回；
 * - 已学习到 stream：由归一化请求直接构造；
 * - 内存缓存的 signed 条目、或持久化副本中未过期的描述：直接返回。
 *
 * 不等待持久化载入：这是渲染期探测，等不到就返回 null，由解析路径补齐。
 * 每次调用都可能返回新对象——引用稳定性属于消费方的展示快照，不属于读取结果。
 */
export function peekMediaAccess(value: string | null | undefined): ResolvedMediaAccess | null {
  if (!value) return null;
  const request = requestOf(value, {});
  if (!request) return { url: value };
  const fragment = splitFragment(value).fragment;
  if (isStreamLearned()) return accessOf(streamDescriptorOf(value, request), fragment);
  const cached = cachedDescriptorOf(cacheKeyOf(currentScope(), request), { evict: false })
    ?? persistedDescriptorOf(request);
  return cached ? accessOf(cached, fragment) : null;
}

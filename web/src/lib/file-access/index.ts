/**
 * 托管媒体访问解析（specs/storage-signed-direct-delivery.md 规则 3）。
 *
 * 浏览器不再把 `/api/files/{key}` 直接作为媒体元素的最终地址：先向
 * `POST /api/files/access` 换取访问描述——S3 后端是预签名直连 URL，local 后端是
 * 应用流式 URL。组件只消费本模块的解析结果，不关心批量、缓存与刷新细节。
 *
 * 模块分工（同目录）：`protocol` 值域与描述契约、`batch` 批次与去重、
 * `cache` 内存缓存、`persisted` 设备本地副本、`state` 会话作用域与形态学习、
 * `proactive` 主动刷新共享调度。
 * 本文件只做编排：查缓存 → 发请求 → 返回结果，以及会话切换的重置顺序。
 */
import { ApiError } from "@/lib/api/client";
import { onSessionChange } from "@/lib/session-lifecycle";

import { abortError } from "./abort";
import { requestDescriptor, resetBatches } from "./batch";
import { cachedDescriptorOf, resetCache } from "./cache";
import {
  awaitHydration,
  hydratePersisted,
  persistedDescriptorOf,
  resetPersisted,
} from "./persisted";
import { resetProactiveRefresh } from "./proactive";
import {
  cacheKeyOf,
  type FileAccessDescriptor,
  FileAccessError,
  type FileAccessOptions,
  type FileDelivery,
  requestOf,
  type ResolvedMediaAccess,
  type ResolvedMediaUrl,
  splitFragment,
  streamDescriptorOf,
  withFragment,
} from "./protocol";
import { beginNewScope, currentScope, isStreamLearned } from "./state";

export { isAbortError } from "./abort";
export { FileAccessError, isManagedMediaValue } from "./protocol";
export type { FileDelivery, ResolvedMediaAccess, ResolvedMediaUrl };

/**
 * 字节请求的凭据模式按分发形态（规则 3.1）：
 * - `signed`：对象存储跨域直连，不带应用 Cookie（`omit`）；
 * - `stream`：同源流式，依赖会话 Cookie（`include`）；
 * - 外部地址（无 delivery）：保持 fetch 默认凭据语义。
 * 单点于此：wavesurfer 的 fetchParams 与 Mediabunny 的 Request 都从这里取。
 */
export function credentialsForDelivery(delivery: FileDelivery | undefined): RequestCredentials | undefined {
  if (!delivery) return undefined;
  return delivery === "signed" ? "omit" : "include";
}

/** 描述 → 访问结果（唯一映射点）；寿命字段只对 signed 有意义 */
function accessOf(descriptor: FileAccessDescriptor, fragment: string): ResolvedMediaAccess {
  const url = withFragment(descriptor.url, fragment);
  if (descriptor.delivery === "stream") return { url, delivery: "stream" };
  return {
    url,
    delivery: "signed",
    expiresAt: descriptor.expiresAt,
    ...(descriptor.refreshAt !== undefined ? { refreshAt: descriptor.refreshAt } : {}),
  };
}

/** 访问结果 → 普通消费方契约（收窄掉主动刷新用的寿命字段） */
function urlOf(access: ResolvedMediaAccess): ResolvedMediaUrl {
  return access.delivery === undefined
    ? { url: access.url }
    : { url: access.url, delivery: access.delivery };
}

/**
 * 同步取已解析结果（不触发网络）：
 * - 外部值 / 非托管值：原样返回；
 * - 已学习到 stream：由归一化请求直接构造；
 * - 内存缓存的 signed 条目、或持久化副本中未过期的描述：直接返回。
 *
 * 不等待持久化载入：这是渲染期探测，等不到就返回 null，由解析路径补齐。
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

/**
 * 解析托管媒体访问地址（规则 3.1）：
 * - 非托管值（外部 http(s) / data: / blob:）原样返回，不发起请求；
 * - stream 形态已学习时同步返回，不发请求；
 * - 内存缓存 / 持久化副本命中时直接返回；
 * - 否则进入同一事件循环的待发批次（批量描述）。
 *
 * `resolveMediaAccess` 保留 signed 的寿命字段，供 Hook 主动刷新（规则 3.8）；
 * 普通消费方走 `resolveMediaUrl`，返回收窄后的契约。
 */
export async function resolveMediaAccess(
  value: string,
  options: FileAccessOptions = {},
): Promise<ResolvedMediaAccess> {
  const request = requestOf(value, options);
  if (!request) return { url: value };

  // stream 形态的地址由逻辑值确定性构造，重新描述不可能改变结果（规则 3.4）：
  // 已学习后连 forceRefresh 也短路——本地/流式部署的手动重试不该白跑一次描述请求
  if (isStreamLearned()) {
    return accessOf(streamDescriptorOf(value, request), splitFragment(value).fragment);
  }

  const fragment = splitFragment(value).fragment;
  const scope = currentScope();
  const cacheKey = cacheKeyOf(scope, request);
  if (!options.forceRefresh) {
    // 等本次会话的持久化载入完成再判命中：否则刷新首屏会在载入完成前全部判成未命中，
    // 白跑一次描述请求（规则 3.2）。强制刷新不读缓存，不必等待
    await awaitHydration();
    // 等待期间会话切换：这次解析属于旧作用域，不能在新会话里重新发起请求
    if (scope !== currentScope()) throw abortError();
    const cached = cachedDescriptorOf(cacheKey, { evict: true }) ?? persistedDescriptorOf(request);
    if (cached) return accessOf(cached, fragment);
  }

  const descriptor = await requestDescriptor(request, cacheKey, options);
  return accessOf(descriptor, fragment);
}

export async function resolveMediaUrl(
  value: string,
  options: FileAccessOptions = {},
): Promise<ResolvedMediaUrl> {
  return urlOf(await resolveMediaAccess(value, options));
}

/**
 * 描述失败中只有瞬时故障值得重描述一次：网络层失败（`status = 0`）与 5xx 中的
 * 非过载状态；逐条失败中只有签发失败属于服务端瞬时故障。503 是媒体池过载信号
 * （带 `Retry-After`，立即重试只会加重过载），与 429 一并按 busy 提示处理；401 已
 * 触发全局登出、404 是对象已删，其余都是终态——重试只会把同一个请求再打一遍
 * （specs/storage-signed-direct-delivery.md 规则 3.6、3.8 与异常边界）。
 */
export function isTransientDescriptorFailure(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 0 || (error.status >= 500 && error.status !== 503);
  }
  return error instanceof FileAccessError && error.code === "files.signing_failed";
}

/**
 * 非元素形态的解析入口（fetch / 探测 / 下载 / 客户端媒体管线），规则 3.6：
 * 描述遇瞬时故障时以 `forceRefresh` 重新描述一次，仍失败才抛错，由调用方进入
 * 自身失败态。媒体元素的失败重试在 Hook 里（`retrySigned`），那条路径同样只重试一次。
 *
 * 返回完整描述（含 `delivery`）：需要按分发形态决定字节请求凭据的消费方
 * （`credentialsForDelivery`）与只需要地址的消费方共用同一条重试规则。
 */
export async function resolveMediaUrlWithRetry(
  value: string,
  options: FileAccessOptions = {},
): Promise<ResolvedMediaUrl> {
  try {
    return await resolveMediaUrl(value, options);
  } catch (error) {
    // 取消不是失败：信号已中止时重试只会立刻再中止一次，直接上抛
    if (options.forceRefresh || options.signal?.aborted) throw error;
    if (!isTransientDescriptorFailure(error)) throw error;
    return resolveMediaUrl(value, { ...options, forceRefresh: true });
  }
}

/** 只需要最终地址的非元素形态（见 `resolveMediaUrlWithRetry`） */
export async function resolveMediaUrlString(
  value: string,
  options: FileAccessOptions = {},
): Promise<string> {
  return (await resolveMediaUrlWithRetry(value, options)).url;
}

/**
 * 会话切换的唯一重置入口（顺序即语义）：先作废旧作用域（在途结果据此判为过期），
 * 再清内存缓存与设备本地副本，随后结算在途/排队请求，最后载入新账号的持久化条目。
 */
onSessionChange(() => {
  beginNewScope();
  // 主动刷新调度与缓存同属会话作用域：旧账号的定时器不得在新会话里触发
  resetProactiveRefresh();
  resetCache();
  resetPersisted();
  resetBatches();
  hydratePersisted();
});
// 模块在账号建立之后才被加载时（懒加载分块），首次解析前也能拿到持久化结果
hydratePersisted();

/**
 * 签名描述的设备本地副本（specs/storage-signed-direct-delivery.md 规则 3.2）。
 *
 * 会话开始时一次性载入本账号条目，解析路径查它时保持同步；载入完成前解析路径
 * 等待 `awaitHydration()`，避免刷新首屏与 IndexedDB 载入赛跑而整屏白跑描述请求。
 *
 * 落盘策略（哪些描述可持久化、目录键形态）在协议层，本模块只负责副本生命周期：
 * 载入、命中判定、写入与清盘。任何 IndexedDB 故障都按「无持久化」处理。
 */
import {
  clearPersistedDescriptors,
  deletePersistedDescriptors,
  type PersistedSignedDescriptor,
  readPersistedDescriptors,
  writePersistedDescriptors,
} from "@/lib/file-access-store";
import { currentAccountKey } from "@/lib/session-lifecycle";

import type { AccessRequest, FileAccessDescriptor } from "./protocol";
import { expiryOf, isPersistable, persistedKeyOf } from "./protocol";
import { currentScope } from "./state";

/** 本账号的持久化描述副本：解析路径按它做同步命中判定 */
let copies = new Map<string, PersistedSignedDescriptor>();

/**
 * 本次会话的持久化载入：解析路径在查缓存前等待它。不等待会在刷新首屏与载入之间
 * 赛跑——载入未完成时缓存看起来为空，整屏媒体白跑一次描述请求（规则 3.2 验收）。
 */
let hydration: Promise<void> = Promise.resolve();

export function awaitHydration(): Promise<void> {
  return hydration;
}

/**
 * 落盘记录 → 描述：寿命判定的唯一入口（载入与命中都走它）。
 *
 * `refreshAt` 缺失原样保留，交给 `expiryOf` 的「失效前 60 秒」兜底——用 `expiresAt`
 * 填补会让跨会话命中把 URL 用到最后一刻，与服务端给出 `refreshAt` 时的余量不一致。
 */
function descriptorOfRecord(record: PersistedSignedDescriptor): FileAccessDescriptor {
  return {
    url: record.url,
    delivery: "signed",
    expiresAt: record.expiresAt,
    ...(record.refreshAt === undefined ? {} : { refreshAt: record.refreshAt }),
  };
}

/**
 * 载入本账号的持久化描述（会话开始 / 账号已知时调用一次）：
 * 作用域不符或已过寿命的条目丢弃，并从磁盘删除。
 *
 * 载入是**合并**而不是整表替换：磁盘读取与解析路径并行，`forceRefresh` 的请求
 * 不等 `awaitHydration()`，会在读取期间经 `persistDescriptor` 写入新条目（先写
 * 内存副本再落盘）。整表替换会把它们随载入结果一起丢掉；若这些 key 恰好也出现在
 * 磁盘快照里且已过期，还会被下面的 stale 删除从磁盘抹掉——表现为「刚写入就消失」。
 *
 * 寿命判定复用 `expiryOf`（而不是直接比 `refreshAt`）：后者在缺 `refreshAt` 时
 * 无可比之值，会把整批条目当成过期。
 */
export function hydratePersisted(): void {
  const account = currentAccountKey();
  if (!account) {
    hydration = Promise.resolve();
    return;
  }
  const scopeAtStart = currentScope();
  hydration = readPersistedDescriptors().then((records) => {
    if (currentScope() !== scopeAtStart || currentAccountKey() !== account) return;
    const stale: string[] = [];
    const now = Date.now();
    for (const record of records) {
      // 载入期间写入的条目比磁盘快照新：内存副本是本会话的权威，既不覆盖也不删盘
      if (copies.has(record.cacheKey)) continue;
      if (record.scope === account && expiryOf(descriptorOfRecord(record)) > now) {
        copies.set(record.cacheKey, record);
      } else {
        stale.push(record.cacheKey);
      }
    }
    void deletePersistedDescriptors(stale);
  }).catch(() => {
    // 载入失败按「无持久化」处理：解析路径必须永远能继续（IndexedDB 是可选加速）
  });
}

/**
 * 持久化条目的命中判定：只在签名形态、非下载、未过期时成立。
 * 作用域已在载入时校验，这里只判寿命（会话内时间在走）。
 */
export function persistedDescriptorOf(request: AccessRequest): FileAccessDescriptor | null {
  if (!isPersistable(request)) return null;
  const record = copies.get(persistedKeyOf(request));
  if (!record) return null;
  const descriptor = descriptorOfRecord(record);
  return expiryOf(descriptor) > Date.now() ? descriptor : null;
}

/**
 * 写入持久化：仅签名描述、仅非下载。先记本会话的内存副本（后续解析立即命中），
 * 再异步落盘；没有账号身份时两处都不写。
 */
export function persistDescriptor(request: AccessRequest, descriptor: FileAccessDescriptor): void {
  if (descriptor.delivery !== "signed" || !isPersistable(request)) return;
  const account = currentAccountKey();
  if (!account) return;
  const record: PersistedSignedDescriptor = {
    cacheKey: persistedKeyOf(request),
    scope: account,
    url: descriptor.url,
    expiresAt: descriptor.expiresAt,
    // 缺失就留缺失：余量由 `expiryOf` 统一决定，不在这里固化
    ...(descriptor.refreshAt === undefined ? {} : { refreshAt: descriptor.refreshAt }),
    savedAt: Date.now(),
  };
  copies.set(record.cacheKey, record);
  void writePersistedDescriptors([record]);
}

/**
 * 会话切换：内存副本与磁盘条目同属账号作用域，登出 / 切换账号必须清盘，
 * 不能留给下一个账号。载入状态一并复位，随后由调用方重新载入。
 */
export function resetPersisted(): void {
  copies = new Map();
  hydration = Promise.resolve();
  void clearPersistedDescriptors();
}

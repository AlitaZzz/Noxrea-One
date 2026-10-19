/**
 * Per-user 存储配额单点（specs/storage-user-quota.md）。
 *
 * 计量口径：用量 = file_objects 按用户 SUM(size) 聚合（PK 前缀索引，不落计数器）；
 * 派生产物与 staging 不在 file_objects 中，天然不计。删除与 GC 回收行后用量自愈回落。
 *
 * 执行点按通道分派，判定与上下文载荷在此单点（409 上下文与 me 的 storage 摘要同源）：
 * - 大小已知通道（直传 ticket / complete、中转逐文件）：findQuotaViolation——
 *   已用量 + 增量 > 配额即违规；
 * - 大小未知通道（生成任务、产出类媒体编辑任务提交）：findQuotaGateViolation——
 *   二元门槛，配额启用且已无余量即违规（不限量配置下永不触发）。
 * 错误包装归通道（UploadDirectError / itemError / failCode），载荷形状单一。
 */
import { prisma } from "@server/core/database/client";
import { getSetting } from "@server/core/settings";

/**
 * 超限上下文载荷：随 409 响应下发，前端据此准确提示。
 * 用 type alias（非 interface）：载荷直接入各通道 ctx 形参（Record<string, string | number>），
 * 结构化字面量类型具备隐式索引签名，interface 则不具备。
 */
export type QuotaExceeded = {
  usedBytes: number;
  quotaBytes: number;
};

/** me 响应的 storage 摘要：quotaBytes 为 null 表示不限量（配置哨兵 0 不出配置域） */
export interface StorageSummary {
  usedBytes: number;
  quotaBytes: number | null;
}

/** 已用量：file_objects 按用户聚合；BigInt 列聚合结果转 Number（安全域内比较，见 Spec 边界） */
export async function getUserUsage(userId: number): Promise<number> {
  const agg = await prisma.fileObject.aggregate({
    _sum: { size: true },
    where: { userId },
  });
  return Number(agg._sum.size ?? 0);
}

/** 配额（字节）：0 = 不限量 */
export function getQuotaBytes(): number {
  return getSetting("storage.quota.default_mb") * 1024 * 1024;
}

/**
 * 大小已知通道的配额判定：已用量 + 增量 > 配额即违规。
 * 返回 null 表示放行（含不限量配置、幂等重添加与边界相等）；违规时返回用量上下文。
 *
 * 幂等重添加豁免（specs/storage-user-quota.md 规则 3 末条，直传与中转同口径）：dedupeHash
 * 命中既有行即代表内容已存在，添加不产生净增占用（SUM 口径不变），跳过判定；
 * 未传或未命中按净增内容正常判定。中转通道无客户端申报 hash，在内容哈希算出
 * （computeBufferHash）后携带于此（见 upload.ts processFile）。
 */
export async function findQuotaViolation(
  userId: number,
  incomingBytes: number,
  opts?: { dedupeHash?: string },
): Promise<QuotaExceeded | null> {
  const quotaBytes = getQuotaBytes();
  if (quotaBytes <= 0) return null; // 不限量

  // 幂等重添加豁免：同 hash 既有行 → 添加不产生净增占用，跳过判定（聚合查询也省去）
  if (opts?.dedupeHash) {
    const existing = await prisma.fileObject.findUnique({
      where: { userId_hash: { userId, hash: opts.dedupeHash } },
    });
    if (existing) return null;
  }

  const usedBytes = await getUserUsage(userId);
  return usedBytes + incomingBytes > quotaBytes ? { usedBytes, quotaBytes } : null;
}

/**
 * 大小未知通道的二元门槛：配额启用且已无余量（used ≥ quota）即违规。
 * 不限量配置下永不触发；恰好占满同样拒绝（增量写入已无空间）。
 */
export async function findQuotaGateViolation(userId: number): Promise<QuotaExceeded | null> {
  const quotaBytes = getQuotaBytes();
  if (quotaBytes <= 0) return null; // 不限量
  const usedBytes = await getUserUsage(userId);
  return usedBytes >= quotaBytes ? { usedBytes, quotaBytes } : null;
}

/** me 响应的 storage 摘要（GET/PUT /api/auth/me 共用）：不限量序列化为 null */
export async function getStorageSummary(userId: number): Promise<StorageSummary> {
  const [usedBytes, quotaBytes] = [await getUserUsage(userId), getQuotaBytes()];
  return { usedBytes, quotaBytes: quotaBytes > 0 ? quotaBytes : null };
}

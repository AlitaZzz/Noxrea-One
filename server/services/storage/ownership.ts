/**
 * 存储 key 归属解析（specs/file-access-ownership.md 业务规则 3）。
 *
 * 按命名空间从 key 结构解析属主 userId；解析不出（非托管命名空间、畸形 key、
 * 旧单向哈希形态）返回 null，调用方一律按「无归属」拒绝（fail-closed，与对象
 * 不存在同响应，不可探测命名空间结构）。key 是自描述归属的标识符而非机密，
 * 防线是调用方（读路由 / 写边界）的归属比对。
 * 形态知识单点：内容键 stem 在 shared/url（hash 对片段派生整键与 stem 两模式）、
 * staging 在 backend.ts、派生命名空间的构造与解析同址在 derived-keys.ts。
 */
import { STORAGE_KEY_STEM_PATTERN, storageKeyStem } from "@noxrea/shared/url";
import { STAGING_KEY_PATTERN } from "./backend";
import { derivedSourceStemOf } from "./derived-keys";

/**
 * 内容键（整键或去扩展名 stem）或 staging key 的属主；整键归属与派生 key 内嵌
 * 源键归属共用的同一两步判定（AGENTS 三.3）。staging key 无扩展名，stem 归一
 * 对其为无害空操作。userId 段匹配 \d+，Number 恒为有效整数（含 0）。
 */
function ownerOfContentOrStaging(value: string): number | null {
  const content = STORAGE_KEY_STEM_PATTERN.exec(storageKeyStem(value));
  if (content) return Number(content[1]);
  const staging = STAGING_KEY_PATTERN.exec(value);
  return staging ? Number(staging[1]) : null;
}

/** 解析存储 key 的属主 userId；非托管命名空间 / 畸形 key 返回 null（调用方 fail-closed）。 */
export function resolveKeyOwner(key: string): number | null {
  const owner = ownerOfContentOrStaging(key);
  if (owner !== null) return owner;

  const stem = derivedSourceStemOf(key);
  return stem ? ownerOfContentOrStaging(stem) : null;
}

/**
 * 归属判定单点：「有权以该 key 操作」= key 解析得出属主且属主即该用户。
 * 解析不出属主（null）按无归属拒绝的 fail-closed 语义内聚于此，
 * 调用方（files 读路由、media-edit 工厂、avatarKey 接受边界）共用同一判定。
 */
export function isKeyOwner(key: string, userId: number): boolean {
  const owner = resolveKeyOwner(key);
  return owner !== null && owner === userId;
}

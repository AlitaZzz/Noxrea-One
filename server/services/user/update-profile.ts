/**
 * 用户资料更新用例（specs/server-crud-service-boundary.md 第 3 节）。
 * 负责字段白名单、头像引用校验链、账本整替与提交后鉴权快照失效；
 * 单表写入与对象存在性查询分别委托 crud 的事务原语。
 * `updateUserTx` 同时供 `change-password` 复用，使画像与凭据在同一事务内提交。
 */
import { hashFromStorageKey } from "@noxrea/shared/url";
import type { User } from "@server/core/database/generated/client";
import type { DbTx } from "@server/core/database/transaction";
import { withUserWriteTx } from "@server/crud/user-write-lock";
import { invalidateAuthSnapshot } from "@server/core/auth/snapshot";
import { hasFileObjectTx } from "@server/crud/file";
import { replaceSourceFileRefTx } from "@server/crud/file-ref-ledger";
import { updateUserFieldsTx, type UpdatableUserFields } from "@server/crud/user";
import { isKeyOwner } from "@server/services/storage/ownership";

/** 头像引用值域错误：avatarKey 须为存储 key 严格形态（与 updateMeSchema 同值域）。 */
export class UserAvatarKeyError extends Error {
  constructor() {
    super("avatar 引用须为存储 key");
    this.name = "UserAvatarKeyError";
  }
}

/**
 * 白名单字段筛选：唯一字段清单，供写入与「是否包含资料字段」判定共用。
 * 新增资料字段只改这里，避免调用方各自维护一份字段列表。
 */
function pickProfileFields(data: UpdatableUserFields): UpdatableUserFields {
  const allowed: UpdatableUserFields = {};
  if (data.avatarKey !== undefined) allowed.avatarKey = data.avatarKey;
  if (data.theme !== undefined) allowed.theme = data.theme;
  if (data.language !== undefined) allowed.language = data.language;
  if (data.isActive !== undefined) allowed.isActive = data.isActive;
  return allowed;
}

/** 判断是否包含任一白名单资料字段；`change-password` 据此跳过空画像写入。 */
export function hasProfileFields(data: UpdatableUserFields): boolean {
  return Object.keys(pickProfileFields(data)).length > 0;
}

/**
 * 事务内资料写入：字段白名单、头像校验链、行更新与账本整替。
 * 调用方负责提交后的跨聚合编排；`change-password` 借此把画像与凭据放进同一事务。
 */
export async function updateUserTx(
  tx: DbTx,
  id: number,
  data: UpdatableUserFields,
): Promise<User> {
  // 白名单过滤收敛于此：仅允许安全字段更新，防止直接设置 hashedPassword 等敏感字段
  const allowed = pickProfileFields(data);

  const avatarKey = allowed.avatarKey;

  // 先验后写：任一校验失败都在写库前抛出，事务内不产生半成品写入
  if (avatarKey !== undefined && avatarKey !== null) {
    const hash = hashFromStorageKey(avatarKey);
    // 引用接受边界（specs/file-access-ownership.md 规则 5）：key 必须内嵌当前用户
    // （归属，isKeyOwner 与读路由同一判定），且对象行已存在（存在性）——否则账本/
    // 聚合要么写不进（无行可加）要么 upsert 出 GC 不可见的惰性聚合行。
    if (!hash || !isKeyOwner(avatarKey, id)) {
      throw new UserAvatarKeyError();
    }
    if (!(await hasFileObjectTx(tx, id, hash))) {
      throw new UserAvatarKeyError();
    }
  }

  const user = await updateUserFieldsTx(tx, id, allowed);

  // avatarKey 是托管引用：与引用账本（avatar 来源，sourceId=用户 id，每用户至多一行）
  // 同事务整替，防止头像对象因账本无行被 GC 当孤儿回收。产品值域 = 存储 key 严格
  // 形态：key → {hash:1}；null → 清空该来源；avatarKey 未出现在更新里则不碰账本。
  if (avatarKey !== undefined) {
    await replaceSourceFileRefTx(tx, { userId: id, sourceType: "avatar", sourceId: String(id) }, avatarKey);
  }
  return user;
}

export async function updateUser(id: number, data: UpdatableUserFields) {
  const user = await withUserWriteTx(id, (tx) => updateUserTx(tx, id, data));

  // 账号状态变更必须在提交后覆盖鉴权快照（specs/auth-request-verification.md 规则 4.2）；
  // 画像字段（头像 / 主题 / 语言）不参与鉴权判定，不触发失效
  if (data.isActive !== undefined) await invalidateAuthSnapshot(user);

  return user;
}

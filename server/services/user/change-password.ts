/**
 * 修改密码用例（specs/server-crud-service-boundary.md 第 3 节）。
 * 画像字段与密码在同一事务内提交：任一步失败整体回滚，避免密码已改而资料写入失败
 * 造成会话失效却返回错误；提交后覆盖鉴权快照，使新 tokenVersion 对所有请求立即生效
 * （specs/auth-request-verification.md 规则 4）。旧密码校验与哈希由 HTTP 层完成。
 */
import { invalidateAuthSnapshot } from "@server/core/auth/snapshot";
import { withTransaction } from "@server/core/database/transaction";
import { updateUserPasswordTx, type UpdatableUserFields } from "@server/crud/user";
import { hasProfileFields, updateUserTx } from "@server/services/user/update-profile";

export async function changePassword(
  id: number,
  hashedPassword: string,
  profile: UpdatableUserFields = {},
) {
  const user = await withTransaction(async (tx) => {
    // 先写画像：头像校验失败会在写库前抛出，密码不会被单独提交
    if (hasProfileFields(profile)) {
      await updateUserTx(tx, id, profile);
    }
    return updateUserPasswordTx(tx, id, hashedPassword);
  });

  await invalidateAuthSnapshot(user);
  return user;
}

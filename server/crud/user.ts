/**
 * 用户 CRUD。
 * 按 ID 与用户名查询用户信息，用户名匹配大小写不敏感。
 */
import { prisma } from "@server/core/database/client";
import { USERS_USERNAME_KEY } from "@server/core/database/constraint-names";
import { isUniqueConstraintViolation } from "@server/core/database/errors";
import { type User } from "@server/core/database/generated/client";
import type { DbTx } from "@server/core/database/transaction";

export async function getUserById(id: number) {
  return prisma.user.findUnique({ where: { id } });
}

export async function getUserByUsername(username: string) {
  // 用户名大小写不敏感：统一按小写匹配
  return prisma.user.findUnique({ where: { username: username.toLowerCase() } });
}

/** 判断唯一约束冲突是否来自用户名：注册查重在事务外，并发同名注册的败方会撞到该约束。 */
export function isUsernameTakenError(error: unknown): boolean {
  return isUniqueConstraintViolation(error, USERS_USERNAME_KEY);
}

export async function createUser(data: {
  username: string;
  hashedPassword: string;
}) {
  // 首个注册用户自动 admin：判定在创建事务内，并由事务级 advisory lock 跨连接/跨实例串行化。
  // PostgreSQL READ COMMITTED 下两个并发事务都可能读到 count=0；SQLite 的写串行化已随 PGlite 移除。
  // 锁 key 含 current_database()：advisory lock 是集群级的，必须按库隔离，避免开发库与测试库互相阻塞。
  // 锁在提交/回滚时自动释放；注册频率低，串行化成本可接受。
  return prisma.$transaction(async (tx) => {
    // 子查询把 void 返回值包成可反序列化的 int：Prisma 无法反序列化 void 列。
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended('noxrea:first-user-registration:' || current_database(), 0))) AS first_user_lock`;
    const role = (await tx.user.count()) === 0 ? "admin" : "user";
    return tx.user.create({
      data: {
        // 用户名统一小写存储，保证大小写不敏感且符合唯一约束
        username: data.username.toLowerCase(),
        hashedPassword: data.hashedPassword,
        role,
      },
    });
  });
}

/** 登录成功后写入最后登录时间。 */
export async function touchLastLogin(id: number) {
  return prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
}

/** 用户可更新字段白名单：类型即边界，事务原语不暴露白名单之外的能力。 */
export type UpdatableUserFields = {
  avatarKey?: string | null;
  theme?: string;
  language?: string;
  isActive?: boolean;
};

/**
 * 对外安全的用户视图：剔除 hashedPassword 等敏感字段。
 * 所有返回给 HTTP 客户端的 user 对象都必须经此转换。
 * displayName 展示回退约定：为空时按 username 回退（Spec user-table-upgrade），消费方不做二次回退。
 * 头像只下发存储 key（avatarKey）：访问 URL 由前端访问解析层（useFileAccessUrl）按分发形态换取，
 * 服务端不再预派生一个必然被签名直连取代的地址。
 */
export function toPublicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? user.username,
    email: user.email,
    role: user.role,
    avatarKey: user.avatarKey,
    theme: user.theme,
    language: user.language,
    isActive: user.isActive,
  };
}

/**
 * 事务内密码单表写入原语：写入新哈希并递增凭据版本号。
 * 只做单聚合写入；与画像字段的同事务编排、鉴权快照失效属于跨层编排，
 * 由 `services/user/change-password` 负责（specs/server-crud-service-boundary.md 规则 3）。
 */
export async function updateUserPasswordTx(
  tx: DbTx,
  id: number,
  hashedPassword: string,
): Promise<User> {
  return tx.user.update({
    where: { id },
    data: { hashedPassword, tokenVersion: { increment: 1 } },
  });
}

/** 事务内按白名单字段更新用户行；调用方负责业务规则与跨聚合编排。 */
export async function updateUserFieldsTx(
  tx: DbTx,
  id: number,
  fields: UpdatableUserFields,
): Promise<User> {
  return tx.user.update({ where: { id }, data: fields });
}

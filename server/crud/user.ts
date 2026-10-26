/**
 * 用户 CRUD。
 * 按 ID 与用户名查询用户信息，用户名匹配大小写不敏感。
 */
import { prisma } from "@server/core/database/client";
import { USERS_USERNAME_KEY } from "@server/core/database/constraint-names";
import { invalidateAuthSnapshot } from "@server/core/auth/snapshot";
import { isUniqueConstraintViolation } from "@server/core/database/errors";
import { type User } from "@server/core/database/generated/client";
import { hashFromStorageKey } from "@noxrea/shared/url";
import { replaceSourceFileRef } from "@server/services/storage/file-ref-ledger";
import { isKeyOwner } from "@server/services/storage/ownership";

/** 头像引用值域错误：avatarKey 须为存储 key 严格形态（与 updateMeSchema 同值域）。 */
export class UserAvatarKeyError extends Error {
  constructor() {
    super("avatar 引用须为存储 key");
    this.name = "UserAvatarKeyError";
  }
}

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

/** 用户可更新字段白名单 */
type UpdatableUserFields = {
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
 * 修改密码的唯一入口：写入新哈希并递增凭据版本号，旧 JWT 立即失效。
 * 鉴权快照必须在提交后覆盖，否则新版本号要等 TTL 才对其他请求生效
 * （specs/auth-request-verification.md 规则 4）。
 */
export async function setUserPassword(id: number, hashedPassword: string) {
  const user = await prisma.user.update({
    where: { id },
    data: { hashedPassword, tokenVersion: { increment: 1 } },
  });
  await invalidateAuthSnapshot(user);
  return user;
}

export async function updateUser(
  id: number,
  data: UpdatableUserFields
) {
  // 白名单过滤收敛于此：仅允许安全字段更新，防止直接设置 hashedPassword 等敏感字段；
  // avatarKey 在过滤前带类型捕获，账本分支免 Record 断言
  const avatarKey = data.avatarKey;
  const allowed: Record<string, unknown> = {};
  const allowedKeys = new Set(["avatarKey", "theme", "language", "isActive"]);
  for (const [key, val] of Object.entries(data)) {
    if (allowedKeys.has(key) && val !== undefined) {
      allowed[key] = val;
    }
  }

  const user = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id }, data: allowed });
    // avatarKey 是托管引用：与引用账本（avatar 来源，sourceId=用户 id，每用户至多一行）
    // 同事务整替，防止头像对象因账本无行被 GC 当孤儿回收。产品值域 = 存储 key 严格
    // 形态（与统一 Spec 的 avatarKey 决策一致，判别单点 hashFromStorageKey，与封面同
    // 规则）：key → {hash:1}；null → 清空该来源；非 key 形态（含外部 URL）fail-closed
    // 抛错，不允许静默丢账本。avatarKey 未出现在更新里则不碰账本。
    if (avatarKey !== undefined) {
      if (avatarKey !== null) {
        const hash = hashFromStorageKey(avatarKey);
        // 引用接受边界（specs/file-access-ownership.md 规则 5）：key 必须内嵌当前用户
        // （归属，isKeyOwner 与读路由同一判定），且对象行已存在（存在性）——否则账本/
        // 聚合要么写不进（无行可加）要么 upsert 出 GC 不可见的惰性聚合行。
        // 与账本整替同事务，检查与写入同生共死
        if (!hash || !isKeyOwner(avatarKey, id)) {
          throw new UserAvatarKeyError();
        }
        const object = await tx.fileObject.findUnique({
          where: { userId_hash: { userId: id, hash } },
          select: { hash: true },
        });
        if (!object) throw new UserAvatarKeyError();
      }
      await replaceSourceFileRef(tx, { userId: id, sourceType: "avatar", sourceId: String(id) }, avatarKey);
    }
    return user;
  });

  // 账号状态变更必须在提交后覆盖鉴权快照（specs/auth-request-verification.md 规则 4.2）；
  // 画像字段（头像 / 主题 / 语言）不参与鉴权判定，不触发失效
  if (allowed.isActive !== undefined) await invalidateAuthSnapshot(user);

  return user;
}

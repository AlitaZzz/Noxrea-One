/**
 * auth 测试共享夹具：对齐服务端 toPublicUser 的真实返回形状
 * （server/crud/user.ts：id/username/displayName/email/role/avatarKey/theme/language/isActive）。
 * 含本轮新增的 email/role/displayName，用于锁定它们不得落入持久 cookie。
 * avatarKey 为头像存储 key（头像只来自上传）；访问地址不在用户 DTO 上，由 useFileAccessUrl 换取。
 */
const AVATAR_HASH = "b".repeat(64);

export const PUBLIC_USER = {
  id: 1,
  username: "alice",
  displayName: "Alice P",
  email: "alice@example.com",
  role: "admin",
  avatarKey: `1/${AVATAR_HASH.slice(0, 2)}/${AVATAR_HASH}.png`,
  theme: "light",
  language: "en",
  isActive: true,
};

/**
 * auth 测试共享夹具：对齐服务端 toPublicUser 的真实返回形状
 * （server/crud/user.ts：id/username/displayName/email/role/avatarUrl/theme/language/isActive）。
 * 含本轮新增的 email/role/displayName，用于锁定它们不得落入持久 cookie。
 */
export const PUBLIC_USER = {
  id: 1,
  username: "alice",
  displayName: "Alice P",
  email: "alice@example.com",
  role: "admin",
  avatarUrl: "/a.png",
  theme: "light",
  language: "en",
  isActive: true,
};

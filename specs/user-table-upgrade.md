# User Table Upgrade

状态：已确认

决策记录：2026-10-10 用户确认全部业务规则（含 displayName 展示回退约定），并确认 OAuth 另行立项。

历史说明：`role` 列并非首次出现——迁移 `20260926120000_drop_user_role_superuser`（提交 78ff68f2）曾因"用户体系实际未使用角色/超管位（单一用户群）"删除过 `role` 与 `is_superuser`。本次重新引入 `role` 是因为目标变为多用户运营与未来管理后台（需要区分 admin / user）；`is_superuser` 不恢复，角色统一由 `role` 表达。

## 目标

升级 `users` 表以支撑未来的管理后台与多用户运营：角色、展示名、邮箱（预留验证位）、最后登录时间；首个注册用户自动成为 admin。本次只做表结构升级与注册/登录的最小逻辑改动，不含管理后台端点。

## 范围

- 仅 `users` 表结构升级（Prisma migration）与两处最小逻辑改动：注册的角色判定、登录的 `lastLoginAt` 写入。
- 明确排除（另行立项）：管理后台端点与界面、邮箱验证/找回密码流程、第三方登录（OAuth）、`displayName` 的前端 UI 消费。

## 业务规则

- `role`：`"user" | "admin"`，默认 `"user"`。**首个注册用户自动为 admin**：判定在注册事务内进行——用户表当前无任何用户时注册得 admin，否则得 user（事务内检查，**不会产生双 admin**；并发首注册的败方可能遇 SQLITE_BUSY 而失败，由客户端重试，路由层不做自动重试）。
- `email`：可选（nullable），唯一约束（SQLite 唯一索引允许多个 NULL 共存）。注册与现有用户**暂不强制**提供；在邮箱验证流程落地前仅作存储，不得用于登录或找回密码。
- `emailVerifiedAt`：nullable，预留列；本次无任何流程写入。
- `displayName`：nullable 展示名；本次仅入库，不强制提供。**展示回退约定**：`displayName` 为空时按 `username` 展示，回退在服务端用户序列化的单点实现（`toPublicUser`），消费方不做二次回退；不设数据库默认值、不在注册时回填（保留"未设置"语义，与 GitHub/Discord 的 nullable 模式一致）。
- `lastLoginAt`：每次成功登录（凭据验证通过后）写入；被禁用账户（`isActive=false`）与密码错误不写。**写入失败只记 warn 日志，不阻断登录**（只写审计列不得有阻断认证的能力）。该写入经 `prisma.user.update` 会顺带刷新 `updated_at`，现无读取方依赖该列。
- `isActive`、`tokenVersion`、`theme`、`language` 语义保持不变；`isActive=false` 仍等效禁用。
- 手动 `UPDATE users SET role='admin'` 保留为未来给其他用户提权的兜底手段。

## 技术影响

- `prisma/schema.prisma` 的 User model + 一次 migration：SQLite 下 Prisma 采用 RedefineTables（重建表 + INSERT...SELECT 迁移数据）而非 ADD COLUMN，数据保留由 Prisma 迁移机制保证，已在 dev.db 真实数据上实测验证。
- 注册路径（auth register）：事务内角色判定。
- 登录路径（auth login）：写 `lastLoginAt`。
- `toPublicUser` 序列化新增 `email`、`role` 字段（管理后台与前端消费的地基）与 `displayName` 回退。**前端 cookie 缓存随本次收口**：`user-cache.ts` 新增 `toUserInfo` 投影，持久 cookie 只落契约字段（id/username/avatarUrl/theme/language），email/role 等新增字段不进 cookie。
- 前端仅做 cookie 投影收口（`user-cache.ts` / `store.ts`），UI 不改动（`displayName` 的 UI 消费另行处理）。
- `lastLoginAt` 为只写审计列（登录写入），本次无读取消费方。

## 异常与边界

- 迁移对现有用户零影响：新列均为 nullable 或带默认值。
- 已有用户存在时的新注册一律为 `user`；用户表被清空后的首个注册重新获得 admin（与"注册时无其他用户"语义一致）。
- 重复 email 注册被唯一约束拒绝；多个未填 email（NULL）共存不冲突。

## 验收标准

- migration 后现有用户数据完整保留，新列存在且默认值正确——已在 dev.db 真实数据上核验（时点在清库前：7 个既有用户全部保留，role 落默认 'user'；随后应用户要求清理了其他测试账户，noxrea 已提权为 admin）。
- 测试：首个用户注册得 admin；已有用户存在时注册得 user；登录后 `lastLoginAt` 更新（写失败不阻断登录、禁用账户不写）；重复 email 被拒；多个 NULL email 共存；前端 cookie 写端只落契约字段（email/role/displayName 不落盘）、登出清 cookie、历史泄漏 cookie 读入被剥离。
- 全量 server 测试、typecheck、lint 通过。

## 待确认事项

（无——2026-10-10 用户已确认：加 email/displayName/lastLoginAt/emailVerifiedAt、首注册用户自动 admin、不做后台与第三方登录。）

## 当前状态

- 已实施：schema、migration（已应用 dev.db）、注册/登录最小改动与回归测试均完成。
- 迁移时点既有用户的 role 均落默认 'user'。开发库（dev.db）后续已清理其他测试账户，仅余 `noxrea`，并已按兜底手段提权为 admin；其他环境部署后需 admin 时同样按兜底手段手动 UPDATE（或等管理后台立项）。部署其他环境需执行 `prisma migrate deploy`。

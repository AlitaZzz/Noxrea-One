# 请求鉴权与吊销（Auth Request Verification）

状态：已确认（2026-10-26 起草，同日用户确认方案；实现已提交 `1bff028d`，剩余实机走查待执行）

上游与关联：

- [user-table-upgrade.md](user-table-upgrade.md)（已实现）：用户表字段与 `toPublicUser`。
- [file-access-ownership.md](file-access-ownership.md)（已实现）：会话归属与能力凭据边界（读路径鉴权语义不变）。
- [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md)（已确认）：批量描述让「每请求一次用户查询」的成本按条目放大，本 Spec 为该成本的根因解法；该 Spec 只依赖本 Spec 的结果。
- [task-queue-bullmq.md](task-queue-bullmq.md)（已实现）：Redis 依赖、启动探测口径（本 Spec 沿用同一口径）。
- [observability-baseline.md](observability-baseline.md)（已确认）：快照命中率、回源与失效失败指标。

## 目标

1. **稳态请求路径零数据库查询**：每个已登录请求的账号状态校验不再依赖一次 `user` 主键查询（当前每次请求一次）。
2. **吊销即时生效**：改密（`tokenVersion` 递增）、禁用（`isActive=false`）在**下一个请求**就对所有实例生效，不依赖 TTL 到期。
3. **Redis 故障时正确性不退让**：Redis 不可用时回源数据库，鉴权结果仍然正确，只是成本回到今天的样子。
4. **消除陈旧画像**：鉴权中间件不再向处理器提供可能过期的画像字段（现状本就没有处理器使用它们）。

## 范围

1. 新增账号状态快照（Redis）：`{ isActive, tokenVersion }`，按用户 id 缓存，TTL 60 秒（代码常量）。
2. 鉴权链路改造：验签 → 快照（miss 回源 + 回填）→ `isActive` → `ver` 比对，顺序固定。
3. 写路径失效：改变 `isActive` / `tokenVersion` 的数据访问函数在提交后失效该键。
4. `AuthUser` 收缩为 `{ id }`（现状全部消费点只用 `id`）。
5. Redis 请求路径客户端收敛为单一连接工厂（限流与本快照共用；BullMQ 保持自己的连接策略）。

## 非目标

- JWT 形态、签名算法、过期时长（`auth.token_ttl_minutes`）不变。
- 服务端会话表 / 刷新令牌 / 「所有设备退出」（当前登出只清 cookie，不吊销 token；这是已记录的能力凭据边界，本 Spec 不新增产品能力）。
- 角色与权限模型（`role` 不参与鉴权判定）。
- 用户名、头像、主题、语言等画像字段的缓存（`/api/auth/me` 本就查库，见规则 3.4）。
- 网关 / 反向代理层的鉴权。
- 快照的跨进程本地二级缓存（进程内单飞已足够，见规则 3.5）。

## 背景与现状（已验证事实）

- 鉴权中间件（[server/http/middleware/auth.ts:92-122](../server/http/middleware/auth.ts)）：`decodeAccessToken`（验签 + 过期）→ `prisma.user.findUnique({ where: { id } })` → `!dbUser || !dbUser.isActive` → `401 auth.user_inactive` → `payload.ver !== dbUser.tokenVersion` → `401 auth.token_invalid`。**每个已鉴权请求一次数据库主键查询**。
- 该中间件是唯一鉴权入口：`authenticateRequest` 被各路由、上传中间件、文件读鉴权直接调用（没有全局鉴权中间件，不存在第二条路径）。
- `AuthUser` 当前声明 6 个字段（`id` / `username` / `avatarKey` / `theme` / `language` / `isActive`），但**全部调用点只读取 `.id`**（全仓 62 处 `auth.user.*` 均为 `.id`；画像字段由 `/api/auth/me` 的 `getUserById` + `toPublicUser` 提供）。
- `tokenVersion` 的唯一写点是 [crud/user.ts:93-98](../server/crud/user.ts) 的 `setUserPassword`（`{ increment: 1 }`）；`updateUser` 的白名单含 `isActive`，但**当前没有任何调用方写入它**；用户删除目前不存在。用户行的写点仅有 `touchLastLogin`（`lastLoginAt`，不影响账号状态）与上述两处。
- 用户行的数据访问唯一入口是 `server/crud/user.ts`（全仓无其他 `prisma.user.update*` / `delete*` 调用）。
- Redis 现状：`ioredis ^6`；任务队列（[queue.ts](../server/services/worker/queue.ts)）用 `maxRetriesPerRequest: null` 的阻塞语义连接；限流（[redis-store.ts](../server/core/ratelimit/redis-store.ts)）用请求路径策略（`enableOfflineQueue: false`、`commandTimeout 2000`、`connectTimeout 3000`、连接错误按间隔去重）。bootstrap 在 Redis 不可达时启动失败（规则见 [bootstrap.ts:35-43](../server/core/bootstrap.ts)）。
- 批量描述（[storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 规则 2.8）把每屏 90 图从 90 次鉴权降为 1–2 次；但每次其余请求（保存画布、轮询、资产列表）仍各带一次用户查询。

## 规则

### 1. 快照模型

1.1 键：`noxrea:auth:snap:<userId>`（与 `noxrea:ratelimit:`、`noxrea:queue:` 同命名空间前缀）。

1.2 值：JSON `{"tokenVersion":<int>,"isActive":<bool>}`。**只存鉴权判定需要的两个字段**，不存画像字段（规则 3.4）。

1.3 TTL：`AUTH_SNAPSHOT_TTL_SECONDS = 60`（代码常量，不入设置）。60 秒的含义：在失效机制完全失效的极端情况下，吊销延迟上界为 60 秒；同时把「操作员绕过应用直接改库」的陈旧窗口限制在一分钟内。

1.4 不做负缓存：不存在的用户、Redis 未命中的失败结果都不写入缓存（否则一个被删用户可长期以「缓存里的不存在」状态存活，或反过来让合法用户被打上错误状态）。

### 2. 校验链

2.1 `authenticateRequest` 的顺序固定：提取 token → 验签与过期 → 取快照 → `!isActive` → `ver !== tokenVersion`。任一步失败即 401，错误码与现状一致（`auth.not_authenticated` / `auth.token_invalid` / `auth.user_inactive`）。

2.2 取快照（读路径）：

1. `GET` 键；命中即用。
2. 未命中 → 进程内按 userId 单飞查库（`SELECT id, isActive, tokenVersion`）→ `SET 键 值 EX 60 NX`。
3. `SET NX` 失败（并发的写路径已经写入了新值）→ 重新 `GET` 并使用键里的值，**不返回自己刚查到的旧值**。
4. `NX` 失败后**读路径不写回**，本次请求用回读结果；回读为空或不可解析时用查库结果，把回填留给下一个请求。两种回读结果都不该被读路径改写：
   - **空值**（键在 NX 与回读之间消失）：可能是错过竞争（写路径刚失效过），也可能是 TTL 自然到期——读路径无法区分两者，重建等于把「查库那一刻的旧值」写回去，前者会让吊销再延迟一个 TTL；
   - **不可解析的脏值**（外部写入 / 旧格式）：覆盖它能在脏值存续期省掉后续回源，但那是无 CAS 的盲写，同样可能落在并发写路径刚提交的新值上。读路径的本职是判定，不是修复存储；脏值会被写路径或 TTL 清掉，期间每请求回源一次是有界代价。
5. 用户不存在 → 直接 401，不写缓存。

2.3 为什么用 `SET NX` 而不是普通 `SET`：普通「查库→写缓存」在「查库完成」与「写缓存」之间若有写路径提交并失效/覆盖，读路径会用旧值覆盖新值，把吊销窗口拉长到整个 TTL。`NX` 让先写入者获胜；读路径发现自己输掉后重新读取，得到权威值，且**不再写回**（规则 2.2 第 4 步）——任何「输掉之后仍写一次」的分支都会重新引入同一个缺陷。这条规则是本 Spec 唯一的并发正确性约束。

2.4 Redis 命令失败（超时 / 连接不可用 / 脚本错误）→ 直接查库（等同今天的行为），记录错误与指标；**不重试、不排队**（沿用限流的请求路径策略：Redis 抖动不得放大为请求排队）。快照读写失败不影响鉴权结果。

2.5 只缓存「账号状态」，不缓存 JWT 解析结果：验签是纯 CPU 成本，缓存它既省不了数据库也引入另一套过期语义。

### 3. 数据形态

3.1 `AuthUser` 收缩为 `{ id: number }`。理由：全部消费点只读 `id`（已核实），现有 6 个字段中 4 个是可能陈旧的画像字段，保留它们等于把「中间件给新鲜用户」的错觉写进类型。画像需求由 `/api/auth/me` 等查库接口承担。

3.2 `toAuthUser` 删除；`authenticateRequest` 直接返回 `{ user: { id } }`。

3.3 `UploadEnv.Variables.uploadUser` 的类型随之收缩（调用点只读 `.id`）。

3.4 画像字段（username/avatarKey/theme/language）**不进快照**：它们由 `/api/auth/me`（`getUserById` + `toPublicUser`）与各业务接口自行查库，语义与今天一致。

3.5 单飞：同一 userId 的并发 miss 在同进程内共享一次查库（与 `runSingleFlight` 同风格的小工具）。跨进程不做协调——每个实例各自最多一次回源，成本可接受。

### 4. 失效

4.1 失效点唯一：用户行的写路径（`server/crud/user.ts`）。在**事务提交成功后**执行失效，不在事务内（事务回滚时缓存已删会造成无谓回源，虽然正确）。

4.2 需要失效的写：`setUserPassword`（`tokenVersion` 递增）、`updateUser`（写入包含 `isActive` 时）；未来的用户删除或「所有设备退出」若落地，必须同时接入（规则 4.5）。

4.3 不需要失效的写：`touchLastLogin`（`lastLoginAt` 与鉴权判定无关），避免每次登录都清一次快照。

4.4 失效方式：`SET 键 新值 EX 60`（写入权威新值，正常情况一次往返）；写入失败则退化为 `DEL 键`，仍失败则记录错误与指标——此时陈旧上界为 TTL（60 秒），且要求「写时 Redis 不可用但读时可用」这一组合，属已记录的边界。写路径的三种结果在读路径之外单独取值（`invalidated` / `invalidated_fallback` / `invalidate_error`）：与读路径共用 `error` 会让写路径失败在指标上不可见，而它正是陈旧上界的唯一来源。无 Redis 连接时不记写路径结果——什么都没尝试，下一次读取自会记 `db_fallback`，在此补记会让回源比例虚高。

4.5 结构性保证：`server/crud/user.ts` 是用户行的唯一数据访问入口（已核实）。规则写入该模块的注释与 Spec；新增写点时同一函数内完成失效。回归测试覆盖 4.2 的每个写点都触发失效。

### 5. Redis 连接

5.1 新增 `server/core/redis/` 连接工厂，提供命名策略：

- `requestPath`：`enableOfflineQueue: false`、`commandTimeout 2000`、`connectTimeout 3000`、连接错误按固定间隔去重 —— 限流与鉴权快照**共用同一条连接**（两者都是请求路径上的旁路依赖，失败语义都是「不排队、快速失败」）。
- BullMQ 的连接**不**走该工厂（需要 `maxRetriesPerRequest: null` 与阻塞命令的专用连接语义），保持现状。

5.2 限流改用该工厂的 `requestPath` 连接；`RedisRateLimitStore` 的连接策略与其 Lua/键前缀逻辑不变（纯机械抽取，行为不变）。

5.3 启动期：Redis 建连失败仍让启动失败（现有口径不变）；鉴权快照不额外增加启动依赖。

5.4 停机：连接随现有 `closeRateLimit` / 停机序列统一收口（工厂持有连接生命周期）。

### 6. 边界与已知限制

6.1 操作员直接改库（绕过应用）：吊销延迟上界为 TTL 60 秒。

6.2 写路径失效失败 + Redis 随后从快照恢复：陈旧上界为 TTL 60 秒。

6.3 多实例时钟不参与本机制（不依赖过期时间做判定，只用 TTL 做过期）。

6.4 已签发的预签名 URL 不受吊销影响（能力凭据边界，见 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 规则 4.5）。

## 技术影响

### 服务端

- 新增 `server/core/redis/`（连接工厂 + 生命周期），`server/core/ratelimit/redis-store.ts` 改用它。
- 新增 `server/core/auth/snapshot.ts`：`readAuthSnapshot(userId)` / `invalidateAuthSnapshot(user)` / 常量。
- [server/http/middleware/auth.ts](../server/http/middleware/auth.ts)：改为走快照；`AuthUser` 收缩为 `{ id }`；删除 `toAuthUser`。
- [server/crud/user.ts](../server/crud/user.ts)：`setUserPassword` / `updateUser`（含 `isActive`）提交后失效；`touchLastLogin` 不动。
- [server/http/middleware/upload.ts](../server/http/middleware/upload.ts)：`UploadEnv` 类型随 `AuthUser` 收缩。
- `server/__tests__`：鉴权中间件与上传中间件相关用例按新语义调整（不再断言画像字段）。

### 前端

- 无变化。`/api/auth/me` 的返回不变。

### 数据与持久化

- 无数据库结构变更。
- Redis 新增一个键命名空间 `noxrea:auth:snap:`，无持久化要求（可从数据库重建）。

### 部署

- 无需新增环境变量；`REDIS_URL` 已是必填（队列与限流）。
- 多实例部署无需粘性会话（快照在 Redis，失效跨实例广播式生效）。

## 异常与边界

- **Redis 抖动**：请求回源数据库，鉴权结果正确；错误日志按间隔去重，指标记录回源次数。
- **Redis 完全不可用**：启动失败（现有口径）；运行期瞬断则全量回源数据库，数据库压力回到今天水平，**不返回 5xx**。
- **用户被删除**：快照仍存在时最多 60 秒内按旧状态放行；随后 `sets` 回源到「不存在」→ 401（此后每次请求各查一次库，因为不做负缓存）。
- **改密后旧 token**：改密提交时快照被覆盖为新 `tokenVersion`，旧 token 的下一个请求即 401；当前会话由改密接口重签 cookie（现有行为）。
- **并发 miss**：同进程单飞，最多一次回源；`SET NX` 失败时以键内值为准。
- **token 解析成功但 `sub` 非法**：与现状一致，401 `auth.token_invalid`。
- **测试环境无 Redis**：快照模块必须能在「Redis 未初始化」时回源数据库（与限流「未初始化即抛错」不同——鉴权不能因为基础设施未就绪而放行或拒绝一切，见规则 2.4；此点由单测固定）。

## 验收标准

### 静态检查与测试

- 稳态零查询：连续两次请求同一已登录用户，数据库用户查询次数为 1（首次 miss）与 0（第二次命中）；快照 TTL 到期后再次回源一次。
- 吊销即时性：`setUserPassword` 之后，用旧 `ver` 的 token 请求 → 401（不等待 TTL）；用重签后的 token → 200。
- 禁用即时性：写入 `isActive: false` 后，下一个请求 → 401 `auth.user_inactive`。
- 跨实例语义：失效后清空进程内状态再请求 → 回源数据库并得到新状态（模拟另一实例）。
- `SET NX` 竞争：模拟「回源期间写路径已写入新值」，断言读路径返回键内的新值而不是自己查到的旧值。
- 键消失不复活：模拟「NX 失败后回读为空」（错过竞争或 TTL 到期），断言读路径不回填键——只发生 NX 那一次 SET。
- 脏值不盲写：模拟「键仍在但内容不可解析」，断言读路径同样不写回（没有第二次 SET），后续请求照常回源。
- 失效接线：`setUserPassword` 与「`updateUser` 写入 `isActive`」都在提交后调用 `invalidateAuthSnapshot`，用 `invocationCallOrder` 断言失效发生在事务提交之后（规则 4.5）；指标取值本身由 `snapshot.test.ts` 覆盖。
- 并发 miss 单飞：同一冷用户 10 个并发请求 → 数据库查询恰好 1 次。
- 无负缓存：不存在用户的重复请求不写入任何键。
- Redis 未初始化 / 命令失败：请求成功且鉴权结果与查库一致；错误指标 +1。
- `AuthUser` 只有 `id`：类型层面无画像字段（编译期保证），`me` 接口返回值不变。
- 类型检查、lint、相关测试串行通过（Vitest 单 worker）。

### 实机走查

- 服务器模式（NAS PG + Redis）：登录后连续翻动画布，数据库日志中的 `user` 查询次数显著下降（对比基线：每请求 1 次）。
- 两个实例（或一个实例 + 手动清进程内状态）下改密：旧 token 立即 401。
- 停 Redis（运行期）：已登录请求仍 200，日志出现回源记录；恢复 Redis 后快照重新填充。

## 实施顺序（确认后）

1. `server/core/redis/` 连接工厂；限流改接（机械抽取，行为不变）。
2. `server/core/auth/snapshot.ts` + 单测（含 `SET NX` 竞争与单飞）。
3. 鉴权中间件改走快照；`AuthUser` 收缩；相关用例调整。
4. crud 写路径失效 + 回归测试。
5. 指标接入（见 observability-baseline）与实机走查。

## 已确认决策（用户反馈）

- 2026-10-26：用户明确要求「Redis 是必须上的，按行业内的前沿成熟方案做，不一定非得改动小为前提」——因此采用 Redis 快照 + 显式失效的结构性方案，而不是「缩短 TTL」或「进程内缓存」这类局部缓解。具体规则待确认。
- 2026-10-26：`AuthUser` 收缩为 `{ id }` 是本次一并清理的既有冗余（已核实无消费点），不属于新增范围。

## 已确认事项（2026-10-26 用户确认）

2026-10-26 用户确认本 Spec 方案通过，原待确认四项按当前实现口径定案：

- 快照 TTL 取 60 秒（非 300/600 秒）：接受把「绕过应用的直接改库」陈旧窗口压到一分钟，代价是每活跃用户每分钟一次回源。
- Redis 命令失败时回源数据库（非 fail-closed 401）：正确性与可用性优先，接受 Redis 故障期间数据库承压。
- 快照命中率只记录指标，不进入 `/api/health`（就绪检查保持布尔与数值）。
- 「所有设备退出」不属本次范围；将来若引入，借 `tokenVersion` 递增实现即可（现有失效接线天然支持），届时另立 Spec。

## 当前状态

已按用户指示实现，代码于 2026-10-26 随 `1bff028d` 提交并推送（此前记录中的「工作区（未提交）」已过时）：Redis 鉴权快照（`server/core/auth/snapshot.ts`，与限流共用请求路径连接）、写路径失效、单飞回源、无负缓存、`AuthUser` 仅 `id`，并接入 `auth_snapshot_total` / `auth_verify_duration_seconds` 指标。写路径的三种结果（`invalidated` / `invalidated_fallback` / `invalidate_error`）与读路径分开取值，覆盖了规则 4.4 的三种结局。

测试（2026-10-26，串行、`--maxWorkers=1`）：`auth/snapshot.test.ts` 15 个用例通过（含「NX 竞争以键内值为准」「脏值不盲写」「写路径结果按结局记指标」回归用例）；server 全量 98 个文件 / 1132 个用例通过；typecheck 与 lint 通过。

复审修复（2026-10-26；代码同批随 `1bff028d` 提交）：

- **输掉 NX 之后仍写一次**：规则 2.2 原只写四步，实现里「NX 失败 → 回读」之后还有一步无条件 `SET`（后改为仅对脏值 `SET ... XX`）。两次修法的共同缺陷是一样的：**读路径输掉竞争后仍可能写回**。回读为空时会把「查库那一刻的旧值」重建；回读为脏值时 `XX` 也是一次无 CAS 的盲写，可能落在并发写路径刚提交的新值上。最终修复：NX 失败后读路径**完全不写回**，脏值期间每请求回源一次作为有界代价；规则 2.2 第 4 步与 2.3 按此改述，验收补「键消失不复活」「脏值不盲写」两条。
- **失效接线无回归覆盖**：规则 4.5 要求「回归测试覆盖 4.2 的每个写点都触发失效」，但此前没有任何用例约束 `setUserPassword` / `updateUser` 的接线。新增 `crud/user-auth-snapshot.test.ts`（5 用例，mock 快照模块与数据库客户端）：改密后以提交结果失效、写入 `isActive` 后失效、只改画像字段不失效、提交失败（含事务回滚）不失效，并用调用顺序断言失效发生在提交之后。
- 修复后 server 全量：102 个文件（99 通过 / 3 个集成用例需外部服务而跳过）、1152 个用例（1138 通过 / 14 跳过），`typecheck` 与 `lint` 串行通过。

（`updateUser` 的 `isActive` 分支目前仍无 HTTP 调用方——`updateMeSchema` 是 `.strict()` 且不含该字段；该字段按规则 4.2 保留为管理端写点的接线，接线本身现由上述用例锁定。）

尚未执行：「实机走查」中的两实例改密、运行期停 Redis 故障注入，需部署环境配合。状态已由用户于 2026-10-26 设为「已确认」；「已实现」待上述两项实机走查通过并经用户验收后设置。

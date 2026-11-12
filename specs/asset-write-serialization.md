# Spec：资产写路径的用户级写串行化（交叉键死锁根因）

状态：已确认

## 当前状态

**已确认**（2026-11-12 由用户明确设置）。用户已确认方案 A（用户级事务锁串行化同一用户的资产/目录/账本写入）与后续根因修复范围；后续 code-review 发现的连接池与测试精确性问题已按根因修复。

实现与验证进度（2026-11-12）：数据库锁、进程内写闸门、写入口与账本原语接入、真实库与单元回归均已落地并通过（详见「验证记录」）。当前缺口：提交后尚待用户确认验收；按 AGENTS §12.4，用户确认验收前保持「已确认」，不标记「已实现」。

## 目标

1. 消除同一用户的资产/目录/账本多资源写事务之间由加锁顺序不一致导致的 PostgreSQL 死锁（40P01）。
2. 不引入全局串行化：不同用户之间保持完全并行；只读路径不加锁。
3. 用单一机制覆盖全部写入口，而不是逐条路径调整加锁顺序（顺序方案要求每个调用方永远遵守同一顺序，新增路径极易回退）。
4. 排队语义不得放大连接池占用：同一用户的并发写必须主要在应用进程内排队，不能每个请求都占用一条数据库连接等待锁。

## 范围

**范围内**：

- 资产与目录写入口：`createFolder`、`updateFolder`、`deleteFolder`、`createAssetsBatch`、`updateAsset`、`updateAssetsBatch`、`deleteAsset`、`deleteAssetsBatch`、`deleteAssetsByFileKeys`（`server/crud/asset.ts`）。
- 画布/头像写入口：`updateProject`（内容与元数据/封面）、`updateProjectDelta`、`deleteProject`、`updateUser`、`changePassword`，经同一事务入口进入用户写闸门与锁。
- 引用账本写原语：`replaceSourceFileRefsTx`、`removeSourceFileRefsBatchTx`（`server/crud/file-ref-ledger.ts`）。
- 锁辅助、进程内 keyed gate 与真实 PostgreSQL / 单元回归测试。

**范围外**：

- 只读查询（`getAssets`、`getFolders`、`getAssetLibrarySummary` 的读部分）与「未分类」目录的短事务准备（`ensureUncategorizedFolder`，见 R6）。
- 存储 GC（`services/storage/gc.ts`）：单事务只操作一行 `file_objects`，不参与多资源加锁环，不纳入本锁。
- 文件对象持久化（`server/crud/file.ts` 与 `server/services/storage/persist.ts` 的 `fileObject.upsert`，调用方 upload / upload-direct / download / media-edit）：每条语句只写一行 `file_objects`，在事务外自动提交，无法与资产/账本事务形成多资源等待环，因此不需要用户锁。若未来把它与资产/账本写合并进同一事务，必须改走 R1。
- 数据库结构、接口契约与前端行为：无变更。

## 业务规则

### R1 写入口统一经 `withUserWriteTx` 进入

每个会写 `asset_items` / `asset_folders` / `file_refs` / `file_objects` 的业务事务，必须调用 `withUserWriteTx(userId, fn)`（`server/crud/user-write-lock.ts`），不得直接调用 `withTransaction` 或 `prisma.$transaction`：

1. 先在本进程的按用户闸门（`server/core/keyed-gate.ts`）内排队；等待期间不开启事务、不占用连接池连接。
2. 轮到本请求后开启事务，第一条语句调用 `lockUserWriteTx(tx, userId)` 获取 `pg_advisory_xact_lock`。
3. 之后才执行 `fn(tx)` 的业务读写。

数据库锁随事务提交/回滚自动释放，同一事务内重复获取可重入。进程闸门是本进程的排队与连接成本优化；数据库锁才是跨进程/跨实例的最终串行化权威，两者缺一不可。

### R2 锁键按用户隔离，并包含当前数据库名

锁键为 `hashtextextended('noxrea:user-write:' || current_database() || ':' || userId, 0)`。不同用户取不同键，互不阻塞；包含 `current_database()` 与既有首用户注册锁（`server/crud/user.ts`）保持同一隔离口径，避免同一集群内的不同库互相阻塞。

### R3 资产/目录写入口全部覆盖

R1 适用于 `server/crud/asset.ts` 中列出的九个写入口。批量入口 `createAssetsBatch` / `updateAssetsBatch` 在进入主事务前的只读探测与「未分类」目录短事务（R6）不持锁，也不进入用户闸门；主事务必须整体由 `withUserWriteTx` 承载。

### R4 账本写原语自身获取同一把锁（可重入）

`replaceSourceFileRefsTx` 与 `removeSourceFileRefsBatchTx` 在首个读写语句前获取同一用户锁（后者在 `sourceIds` 为空时原样提前返回，不加锁）。这样即使调用方没有走 R1，账本原语的正确性仍由数据库锁保证；资产/画布/头像入口已走 R1，二次获取依赖 `pg_advisory_xact_lock` 的可重入语义。注意：直接调用账本原语而不走 R1 时只有锁、没有进程闸门，排队会占用连接——新增入口必须使用 R1。

### R5 锁先于共享行锁的获取顺序不变量

`asset_items` / `asset_folders` / `file_refs` / `file_objects` 是资产写与画布/头像写共享的行资源。任何事务对上述资源加行锁之前，必须先持有该用户的写锁；画布/头像事务在拿用户锁之前只允许锁定其自身业务行（`canvas_projects`、`users`），这些行不会被资产事务持有，因此不构成环。

例外仅限本 Spec 明确列出的豁免：R6 的「未分类」目录短事务，以及范围外的单行文件对象持久化/存储 GC。

应用内闸门的嵌套顺序固定为「项目闸门 → 用户闸门」；反向获取会形成数据库看不到的等待环（尚未开启的事务不进入锁管理器）。

PostgreSQL 的 advisory 锁与行锁共用同一锁管理器与等待图，死锁检测同样覆盖 advisory 锁等待；违反该不变量仍会以 40P01（Prisma P2034）终止，而不是等待超时 P2028。新增调用方必须遵守。

### R6 只读路径与「未分类」目录准备不持锁

`getAssetLibrarySummary` 与 `getFolders` 等只读路径不加锁，也不进入用户闸门。`ensureUncategorizedFolder` 的独立短事务只执行一条冲突容忍的目录插入（`INSERT ... ON CONFLICT DO NOTHING`），不持有其它资源，也不进入用户闸门；若让它等待用户锁，并发首访会重新等待可能持续数秒的批量事务，退化为此前已修复的 P2028 路径（见 `postgres-dialect-unification.md` 2026-11-12 增量）。

### R7 失败语义

1. 进程闸门内的等待发生在事务之外，不受 Prisma 交互式事务 5s 预算约束；它只排队，不产生数据库错误，也不占连接。
2. 进入事务后等待其他实例持有的数据库锁时，仍受默认 5s 事务预算约束；超时表现为 P2028，与既有行锁等待一致。
3. 本方案不增加重试、不吞异常、不改变路由错误映射。

## 技术影响

- 新增 `server/core/keyed-gate.ts`：通用进程内按 key 的 promise-tail 闸门；画布每项目临界区（`editor-lease.ts`）也改用同一实现，行为不变。
- `server/crud/user-write-lock.ts`：`lockUserWriteTx` 为锁键推导与 SQL 的唯一实现；`withUserWriteTx` 为用户写事务的唯一入口（闸门 + 事务 + 锁）。
- `server/crud/asset.ts` 九个写入口改为 `withUserWriteTx`；批量插入的 `ON CONFLICT` 语句抽取为 `insertAssetItemRowTx`，数据库仍是来源唯一性的最终裁决者。
- `server/crud/file-ref-ledger.ts` 两个写原语接入锁（可重入）。
- `server/crud/canvas.ts` 的 `deleteProject`、`server/services/canvas/project-write.ts` 的内容/元数据写、`update-profile.ts` 与 `change-password.ts` 的事务入口改走 `withUserWriteTx`。
- 无 schema、迁移、HTTP 契约与前端变更。
- 性能与连接占用：同一用户的写事务由数据库串行化；每进程每用户至多一个事务占用连接（活动事务或跨实例锁等待），其余同用户请求在进程内排队，不占连接。跨实例时每个实例各有一道闸门，数据库锁仍是唯一权威。

## 异常与边界

1. **进程内队列无界**：同一用户的并发请求在进程内 FIFO 排队，不设队列上限；请求时长由 HTTP/客户端超时约束。这是「不占连接」的代价，若未来需要准入控制（429/503）应单独定义接口契约。
2. **跨实例锁等待超时**：等待其他实例持有的锁超过 Prisma 事务预算时，该请求以 P2028 失败；不重试。
3. **进程/实例崩溃**：事务级 advisory 锁由连接结束或事务终止自动释放，无残留锁、无租约续期问题。
4. **跨库隔离**：锁键包含 `current_database()`；开发库、测试库与生产库互不阻塞。64 位哈希碰撞只会让两个用户额外串行，不影响正确性。
5. **同事务重入**：`pg_advisory_xact_lock` 在同一事务内重复获取递增计数、提交时统一释放，资产路径内「入口锁 + 账本原语锁」不自我阻塞。
6. **顺序不变量失守**：任何新增写路径若先锁共享行、后拿用户锁，可能形成等待环；PostgreSQL 死锁检测覆盖 advisory 锁等待，会以 40P01 终止（不是 P2028）。该风险由 R5 与 Spec 评审约束，不在运行时兜底。
7. **长批次占用锁**：大批量创建/删除期间，该用户的其它写请求在进程内排队；跨实例请求最坏以 P2028 失败。批量语义本身允许重试；这是「单用户串行」的既定代价。
8. **进程闸门不是分布式锁**：多实例部署下闸门各自独立，跨实例互斥完全依赖事务内 advisory 锁；不得因为存在闸门而移除数据库锁。

## 验收标准

1. 同一用户：第二个写在前一个事务结束前不开启事务（进程内排队，不占连接）；不同用户可同时进入事务；事务失败释放闸门；用户锁先于业务写获取。
2. 跨实例语义：独立事务持有用户锁时，`createFolder` 必须在该锁上等待；释放后完成。
3. 跨用户：用户 A 的锁被持有时，用户 B 的写不等待 A 的锁，正常完成。
4. 账本原语：独立事务持有该用户锁时，`removeSourceFileRefsBatchTx` 必须等待；释放后完成；空来源列表不获取锁。
5. 来源唯一性：未提交的重复来源行提交后，`insertAssetItemRowTx` 返回 `conflict`；无 `fileKey` 的空结果直接抛错。
6. 既有真实库回归全部通过：批量创建同来源并发、未分类目录并发、资产移动/删除、账本文档与批量回收。
7. `tsc --noEmit`、eslint 与相关 Vitest 用例通过。

## 验证记录

2026-11-12，本地真实 PostgreSQL `noxrea_test`：

- 单元回归 7 个文件 67 用例通过：`user-write-lock.test.ts`（4）、`asset-insert-row.test.ts`（3）、`file-ref-ledger.test.ts`（6）、`project-write.test.ts`（19）、`update-profile.test.ts`（10）、`change-password.test.ts`（5）、`editor-lease.test.ts`（20）。
- 闸门红灯验证：临时把 `withUserWriteTx` 改为直接开启事务（去掉进程闸门），`user-write-lock.test.ts` 的「同一用户：前一个事务结束前不开启后一个事务」以 `expected "spy" to be called 1 times, but got 2 times` 失败；恢复实现后 4/4 通过。
- 真实库串行回归 10 个文件 61 用例通过（`--no-file-parallelism`）：写锁 3、批量创建并发 3、未分类目录并发 4、移动/删除 4、删除 7、目录约束 3、资产 9、账本 6、账本批量回收 7、头像账本 15。
- 精确等待验证：三个并发编排文件在默认文件并行度下同时运行（`setupTestDatabase` 会话锁会制造无关 advisory 等待者），10 用例全部通过——`waitForAdvisoryLock` 按持有者 pid 与锁键匹配，不会把无关等待当成命中。
- 相关回归 6 个文件 82 用例通过：`crud/canvas.test.ts`（17）、`http/routes/canvas.test.ts`（21）、`http/routes/assets.test.ts`（7）、`http/routes/auth.test.ts`（19）、`architecture/layer-boundaries.test.ts`（9）、`services/canvas/prompt-template.test.ts`（9）。
- 前端：`use-batch-connect-drag.test.ts` 18 用例通过；卸载用例按函数身份断言三个 window 监听器被注销。
- `npm run typecheck`（server + web）通过；变更文件 eslint 通过。
- 测试后核对：`write-lock-*` / `batch-create-race-*` / `uncategorized-race-*` 用户零残留，`pg_locks` 中 advisory 锁零残留。

## 待确认事项

- 无功能性待确认项；方案 A 与后续根因修复（进程内闸门、精确锁等待匹配、ON CONFLICT 直接覆盖）已由用户在 2026-11-12 会话内确认/授权。
- Spec 状态（「已确认」/「已实现」）由用户设置。

## 决策记录

| # | 决策 |
| --- | --- |
| D1 | 采用用户级事务 advisory 锁串行化同一用户的写事务（方案 A）；不采用逐路径调整加锁顺序。 |
| D2 | 在事务之外增加进程内按用户闸门：原先「不引入应用内单用户队列」的决策会令每个排队请求占一条连接，同一用户即可耗尽每进程连接池，故由本 Spec 取代。数据库锁仍是跨实例权威，闸门只负责进程内排队。 |
| D3 | 用户写事务统一收敛到 `withUserWriteTx`；资产/画布/头像入口直接调用，账本原语保留锁作为正确性兜底（可重入）。 |
| D4 | 锁键包含用户 id 与 `current_database()`，复用 `server/crud/user.ts` 的既有锁隔离口径。 |
| D5 | 「未分类」目录短事务与只读路径不持锁、不进闸门，保留此前修复的并发首访不等待长事务语义。 |
| D6 | 应用内闸门嵌套顺序固定为「项目闸门 → 用户闸门」。 |
| D7 | `ON CONFLICT` 保留为数据库最终裁决，并抽取 `insertAssetItemRowTx` 直接覆盖冲突/契约破坏分支；批量并发用例继续覆盖端到端「第二批次跳过」。 |

# PGlite 本地库模式移除（PGlite Removal）

状态：已确认（2026-10-21，用户确认 D1–D6 全按推荐；实施中，工作区已实现并提交，真实库、迁移授权与全量测试验收通过；第四轮审查问题已修复并复验；剩余业务冒烟）

## 目标

移除进程内 PGlite 本地数据库模式，使应用只存在一种数据库运行时：外置 PostgreSQL（服务器模式）。

- `DATABASE_URL` 成为必填的 `postgres(ql)://` 连接串，缺失或非法在启动期大声失败，无任何回退。
- 删除本地数据目录锁、本地迁移 runner、双模式分支与三个 PGlite 相关依赖。
- 消除与独立 Worker / 多实例拓扑不兼容的第二运行时：PGlite 独占数据目录锁，第二个进程无法打开同一库（[client.ts:64-95](../server/core/database/client.ts)）。
- 收敛“开发 / 测试 / 生产”的数据库语义为同一条路径：外置 PG + 部署侧 `prisma migrate deploy`。

## 范围

**范围内：**

1. 数据层瘦身：`server/core/database/client.ts`、`server/core/database/migrate.ts`、`server/core/bootstrap.ts`、`server/index.ts`、`prisma.config.ts`。
2. `DATABASE_URL` 必填校验与错误文案（放在数据库层首次使用点，bootstrap 提前触发，不进入全局 config schema——避免纯工具测试被迫提供数据库连接）。
3. 迁移授权链路：`scripts/db/author-migration.mts` 由 `createPgliteMigration` 改为真实 PG 的官方开发工作流（`prisma migrate diff --from-migrations --to-schema`，只读 shadow 库）；`scripts/storage/cli-bootstrap.mts` 移除本地迁移调用。
4. 依赖清理：`@electric-sql/pglite`、`pglite-prisma-adapter`、`prisma-pglite`。
5. 测试基座：5 个真实库测试从 `file:` PGlite 迁移到 `TEST_DATABASE_URL`，新增统一 helper（门控、迁移、隔离、清理）；其余测试不受影响。
6. 文档与配置：`README.md`、`.env.example`、`.gitignore`、`prisma/schema.prisma` 注释。
7. Spec 回写：`specs/postgres-dialect-unification.md`（D3/D4 及本地模式相关实现记录标注被本 Spec 取代）、`specs/env-config-layout.md`（`DATABASE_URL` 必填）、`specs/storage-reference-key-unification.md`（历史记录中的本地模式执行说明标注已失效）、`specs/system-settings-db.md`（本地开发迁移说明改为 `predev` 钩子执行 `db:migrate:deploy`）。

**非目标：**

- 不移除本地存储后端（`LocalStorageBackend`）：它是 `StorageBackend` 接口的开发/测试适配器，与 PGlite 的“第二数据库运行时”性质不同（见背景）。
- 不改数据库方言、`prisma/schema.prisma` 业务模型、既有迁移文件内容。
- 不改生产 `docker-compose.nas.yml` / `docker-entrypoint.sh` 行为（本来就是服务器模式 + `prisma migrate deploy`）。
- 不做 PGlite 存量数据迁移（AGENTS 一.1：不需要向后兼容；PGlite 数据仅存在于开发机）。
- 不引入 Worker 拆分、多实例部署或分布式协调（另立 Spec）。

## 背景与现状（已验证事实）

| # | 事实 | 出处 |
| --- | --- | --- |
| 1 | 数据库客户端为双模式：`postgres(ql)://` → `PrismaPg`；`file:` 或未设置 → PGlite + 数据目录锁 + 本地迁移 runner | [client.ts:1-7](../server/core/database/client.ts)、[:119-138](../server/core/database/client.ts) |
| 2 | 本地模式启动迁移 `ensureLocalMigrations` 在 bootstrap 第 2 步执行；服务器模式为 no-op | [bootstrap.ts:22-28](../server/core/bootstrap.ts)、[client.ts:167-178](../server/core/database/client.ts) |
| 3 | 本地迁移 runner 自行解析 `prisma/migrations`、维护 `_prisma_migrations` 记账并应用事务（约 80 行） | [migrate.ts:1-79](../server/core/database/migrate.ts) |
| 4 | 关停流程调用 `closeLocalDatabase`（PGlite checkpoint + 释放目录锁） | [index.ts:55-59](../server/index.ts)、[client.ts:152-165](../server/core/database/client.ts) |
| 5 | 迁移授权 `npm run db:migrate:new` 依赖 `prisma-pglite` 的 `createPgliteMigration`（影子 PGlite + schema 差分），不启动任何数据库 | [author-migration.mts:1-28](../scripts/db/author-migration.mts)、[prisma.config.ts:1-23](../prisma.config.ts) |
| 6 | 存储类 CLI 的 `bootstrapCliCore` 调用 `ensureLocalMigrations`（服务器模式下为 no-op，但形成本地模式依赖） | [cli-bootstrap.mts:12-18](../scripts/storage/cli-bootstrap.mts) |
| 7 | 5 个真实库测试使用临时目录 `file:` URL + `ensureLocalMigrations` + `closeLocalDatabase`：settings、user、user-avatar-ledger、asset-folder-constraint、file-ref-ledger-bulk | [settings/index.test.ts:14-45](../server/__tests__/core/settings/index.test.ts) 等 |
| 8 | 生产容器固定服务器模式：compose 注入 `DATABASE_URL`，entrypoint 执行 `prisma migrate deploy` 后启动 | [docker-entrypoint.sh:150-170](../docker-entrypoint.sh)、[docker-compose.nas.yml](../docker-compose.nas.yml) |
| 9 | README 与 `.env.example` 仍将“不设置 DATABASE_URL 即本地模式”作为快速开始路径 | [README.md:96](../README.md)、[:149](../README.md)、[.env.example:36-41](../.env.example) |
| 10 | 当前开发环境已使用 NAS PostgreSQL 与 S3 演练桶，日常不使用 PGlite | 用户 2026-10-21 陈述 |
| 11 | 本地存储后端被至少 9 个存储/上传测试文件使用，是测试基座；生产为 S3，且启动探测失败即失败、无静默降级 | `grep LocalStorageBackend server/__tests__`；[bootstrap.ts:46-55](../server/core/bootstrap.ts) |

补充：`server/__tests__/services/json-loader.test.ts`、`upload-direct.test.ts` 中也出现 `file:` 字面量，但并非真实数据库用例；实施时以是否调用 `ensureLocalMigrations` / 访问 `prisma` 为准逐一核对。

## 业务规则（方案）

**R1 — 单一运行时。** `DATABASE_URL` 必填且必须以 `postgres://` 或 `postgresql://` 开头。缺失、空串、`file:` 或其他前缀时，在首次数据库访问前抛出明确错误，文案包含“PGlite 本地模式已移除，请提供外置 PostgreSQL 连接串，并先执行 `npm run db:migrate:deploy` 初始化数据库”。bootstrap 在原本调用 `ensureLocalMigrations` 的位置触发校验，保证启动期失败。

**R2 — 无回退分支。** 删除 PGlite 导入、adapter、数据目录解析、目录锁、`isServerMode`、`resolveLocalDataDir`、`ensureLocalMigrations`、`migrate.ts`。不存在任何“连接失败退回本地库”的路径。

**R3 — 迁移语义统一。** 应用启动不执行迁移；迁移由部署侧 `prisma migrate deploy` 负责（幂等、只应用未执行的迁移、不做 drift 检测与重置）。容器 entrypoint 的既有行为保持不变（启动前执行 deploy）；面向 B/C 多实例拓扑时，迁移应改为部署流水线中的一次性 job/init 步骤，在应用副本滚动启动前完成，禁止每个应用实例各自执行迁移。新增 `db:migrate:deploy` 脚本（`prisma migrate deploy`）供开发机显式执行，并在 `dev` 前由 `predev` 钩子自动执行（D6）；脚本必须经进程入口注入 env（`tsx --env-file=.env` 包装或等价方式），因为 Prisma 7 CLI 不再自动加载 `.env`。README 的快速开始改为“设置 DATABASE_URL → `npm run db:migrate:deploy` → 启动”。

**R4 — 迁移授权改为真实 PG 官方工作流。** `db:migrate:new` 不再依赖影子 PGlite，改为 `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`：Prisma 把迁移目录回放到 `SHADOW_DATABASE_URL` 指定的 shadow 库后与 schema 差分，输出 SQL；**不连接 `DATABASE_URL`、不应用迁移、不重置任何应用库**（已验证：`DATABASE_URL` 指向不可达地址时仍能生成正确 SQL）。脚本要求 `SHADOW_DATABASE_URL` 必填且不得与 `DATABASE_URL` 指向同一个数据库（按 host/port/database 判定，忽略协议写法与查询参数），按 UTC 时间戳创建迁移目录并写入 `migration.sql`；空差分（去除 `--` 行注释与块注释后无 SQL，不依赖 Prisma 的具体提示文案）视为“无差异”，不创建目录。生成后执行一次 `prisma generate`（v7 不再随迁移命令自动生成）。`prisma.config.ts` 在 CLI 加载时对已设置的 `DATABASE_URL` / `SHADOW_DATABASE_URL` 做格式校验并拒绝同库，非 postgres 值不会透传给 CLI。生成的迁移提交后统一由 `migrate deploy` 应用；shadow 库配置在 `prisma.config.ts` 与 `.env.example` 中说明。

**R5 — 测试库独立且受保护。** 真实库测试只用 `TEST_DATABASE_URL`，永不使用 `DATABASE_URL`（`DATABASE_URL` 未设置时没有可保护的应用库，仅保留库名规则）：

1. 未设置 `TEST_DATABASE_URL` 时，非 CI 环境整体跳过（沿用 `TEST_REDIS_URL` 集成测试的自门控模式），其余测试照常运行；CI 环境未设置则直接失败，禁止用跳过掩盖缺失的真实库覆盖；
2. 设置后，测试基座先做安全校验：URL 数据库名必须包含 `test`，且不得与原始 `DATABASE_URL` 指向同一 host/port/database（忽略协议写法与查询参数差异）；任一不满足即硬失败，禁止任何 `migrate deploy` 或 `TRUNCATE`。库名检查是防误配启发式（子串匹配），不是安全边界；真正阻止破坏性操作的是同库判定。校验必须在 globalSetup 的迁移部署之前、以及文件级清理之前各执行一次；
3. 测试运行前由全局 setup（`vitest.config.ts` 的 `globalSetup`）以 `DATABASE_URL=TEST_DATABASE_URL` 显式注入并执行一次 `prisma migrate deploy`（Prisma 7 CLI 不自动加载 `.env`）；
4. 跨 worker 的文件级隔离必须有效（不能只靠进程内单例）：使用 PG 会话级 advisory lock（独立连接持锁至文件结束）+ 每个文件开始前 `TRUNCATE ... RESTART IDENTITY CASCADE` 清空 public 表；`_prisma_migrations` 必须排除，不得清空迁移记账；直连驱动 `pg` 与类型 `@types/pg` 显式加入 devDependencies。
5. 应用侧 Prisma 客户端仍读 `DATABASE_URL`：helper 在文件开始时保存原值、临时将 `process.env.DATABASE_URL` 指向 `TEST_DATABASE_URL`，文件结束关闭客户端并恢复原值，避免跨文件进程环境污染。

**R6 — 客户端与关停简化。** 保留惰性 `prisma` Proxy 与按连接串键控的缓存（测试可能指向不同库）；删除 `DatabaseEntry.pglite` / `migrated` 字段。`closeLocalDatabase` 更名为 `closeDatabase`，语义收窄为 `$disconnect` + 清缓存，不再有 checkpoint/锁。bootstrap 日志移除 `mode` 字段，保留 `target`（`pg user@host:port/db`，不出现密码）。

**R7 — 文档与依赖收口。** README、`.env.example`、`.gitignore`、`prisma/schema.prisma` 注释同步；三个 PGlite 包不再是直接依赖（`npm ls <pkg> --depth=0` 为空）；`@electric-sql/pglite` 仍会作为 Prisma CLI 的传递依赖（`prisma -> @prisma/dev`）存在于 `node_modules`，允许保留；运行时代码、脚本与构建配置无 PGlite 导入或可执行路径，仅允许说明“已移除”的注释、错误文案、Spec 链接与 Prisma 生成的 inlineSchema（Spec 历史与 lockfile 除外）。

**R8 — 数据库创建与 schema 迁移的职责边界。** PostgreSQL 服务本身不会创建应用数据库或表；`prisma migrate deploy` 只负责应用迁移（在角色具备 CREATEDB 且连接器支持时会尝试创建缺失的数据库，权限不足则明确失败）。生产环境的数据库、账号与权限由部署侧准备（compose 的 `POSTGRES_DB` 或管理员操作），应用运行时（PrismaClient）永不建库建表。新环境上线顺序：建库与最小权限账号 → `migrate deploy` → 启动应用；任一步失败都必须在启动前暴露，不得带未迁移 schema 提供服务。

## 技术影响

| 文件 | 变更 |
| --- | --- |
| `server/core/database/connection-string.ts` | 新增连接串校验、目标描述与同库判定：`isPostgresDatabaseUrl`、`assertDatabaseUrl`、`describeDatabaseTarget`、`parsePostgresDatabaseTarget`、`isSameDatabaseTarget`、`assertDistinctDatabaseTargets`；解析与错误文案统一由一个内部入口提供，描述函数不会接受未校验串；shadow / 测试库的同库守卫共用该 target 判定与统一文案 |
| `server/core/database/client.ts` | 删除 PGlite 分支、锁、目录解析、`ensureLocalMigrations`；保留惰性 Proxy 与连接串键控缓存；首次取客户端时触发连接串校验；`closeDatabase` |
| `server/core/database/migrate.ts` | 删除（连同 `runPendingMigrations`） |
| `server/core/bootstrap.ts` | 删除 `ensureLocalMigrations` 调用与 `isServerMode` 分支；日志只保留 `target`；在数据库步骤触发 R1 校验 |
| `server/index.ts` | 关停调用改为 `closeDatabase` |
| `prisma.config.ts` | `DATABASE_URL` / `SHADOW_DATABASE_URL` 一经设置即校验为 postgres 连接串（非法值在 CLI 启动前失败，不透传给 CLI）；`datasource.url` 在 `DATABASE_URL` 存在时提供；`shadowDatabaseUrl` 独立提供（DATABASE_URL 缺失时迁移授权仍可用）且不得与 `url` 指向同一个数据库（host/port/database 判定）；不使用会强制抛错的 `env()`，保持 `prisma generate` 在无任何 URL 时可运行（镜像构建/postinstall 不要求数据库凭据）；移除本地模式分支；连接串校验与同库判定复用 `server/core/database/connection-string.ts` |
| `scripts/db/author-migration.mts` | 改用 `prisma migrate diff --from-migrations --to-schema --script`：只读 shadow 库，不连接/重置应用库；空差分（去注释后无 SQL）不创建目录；按 UTC 时间戳写迁移目录并执行一次 `prisma generate`（v7 不再自动生成）；迁移名做白名单校验（防路径注入）并在错误文案中说明允许字符集；迁移目录与 schema 使用基于 `repoRoot` 的绝对路径，与 CLI 调用共用同一路径来源；输出提示改为“审阅 SQL 后执行 db:migrate:deploy” |
| `scripts/lib/prisma-cli.mts` | 新增 Prisma CLI 调用单点（脚本与测试 globalSetup 共用）：定位 CLI、继承/捕获 stdio、失败时保留子进程退出码并脱敏连接串 |
| `scripts/lib/paths.mts` | 新增仓库根路径常量（按模块位置解析，不依赖调用方 cwd），供 Prisma CLI 定位与迁移脚本共用 |
| `server/core/database/constraint-names.ts` | 新增业务依赖的唯一索引名常量（P2002 只暴露索引名，见 errors.ts）；真实库测试仍用字面量锁定数据库实际索引名 |
| `server/core/database/errors.ts` | P2002 由按列名匹配改为按索引名匹配（adapter-pg 7.10 只提供 `constraint.index`），helper 更名为 `isUniqueConstraintViolation`，调用方与真实库测试同步 |
| `server/crud/user.ts` | 首注册 admin 判定加事务级 `pg_advisory_xact_lock`（锁 key 含 `current_database()`），消除 PostgreSQL READ COMMITTED 下并发双 admin |
| `scripts/storage/cli-bootstrap.mts` | 移除 `ensureLocalMigrations` 调用 |
| `package.json` | 移除三个 PGlite 依赖；新增 `db:migrate:deploy`（经 `tsx --env-file=.env` 注入 env）与 `predev` 钩子；`db:migrate:new` 增加 `--env-file=.env`（授权需要 SHADOW_DATABASE_URL）；显式声明 `pg` 与 `@types/pg` devDependency（测试隔离直连，当前仅为传递依赖，版本与 `@prisma/adapter-pg` 对齐） |
| `vitest.config.ts` | 注册 `globalSetup`（安全校验 + `TEST_DATABASE_URL` 迁移部署） |
| 5 个真实库测试 | 改用 `TEST_DATABASE_URL` + 统一 helper；删除 `file:` 临时目录与 `closeLocalDatabase` 用法 |
| `server/__tests__/helpers/` | 新增数据库测试 helper（门控、安全校验、`DATABASE_URL` / `LOG_LEVEL` 切换与恢复、文件级 advisory lock、`TRUNCATE ... RESTART IDENTITY CASCADE`、清理）；`LOG_LEVEL=ERROR` 由 helper 统一设置，5 个测试文件不再各自维护保存/恢复样板 |
| `README.md` | 移除本地模式描述与 `data/` 目录说明；快速开始改为 PG 必填 |
| `.env.example` | `DATABASE_URL` 改为必填示例；移除本地模式注释；补充 `TEST_DATABASE_URL`、`SHADOW_DATABASE_URL`（`db:migrate:new` 必需，不得与 `DATABASE_URL` 相同） |
| `.gitignore` | 保留根锚定 `/data/`：历史 PGlite 数据仍在盘上，目录不应被 Git 跟踪（可由开发者自行删除）；忽略迁移授权的 `prisma/.tmp-migration-*` 临时目录 |
| `prisma/schema.prisma` | 顶部注释移除 PGlite 表述 |
| `specs/postgres-dialect-unification.md` | 增量说明：D3/D4 与本地模式 runner 被本 Spec 取代；单方言/Prisma 7 结论不变 |
| `specs/env-config-layout.md` | `DATABASE_URL` 必填；`TEST_DATABASE_URL` 归属测试环境（进 `.env.example` 注释） |
| `specs/storage-reference-key-unification.md` | 历史记录中的“本地 PGlite 完成迁移”标注为已失效 |
| `specs/system-settings-db.md` | 本地开发迁移说明改为 `predev` 钩子执行 `db:migrate:deploy`（原 `prisma migrate dev` 描述失效） |

## 异常与边界

- **旧 `file:` URL 或未设置**：启动失败并给出可行动文案；不自动转换、不回退。
- **存量 `data/pglite`**：不再被任何代码读取；由开发者自行删除。不做数据迁移工具。
- **测试库误配置**：库名不含 `test`、或等于原始 `DATABASE_URL` → globalSetup 与 helper 均硬失败。此保护必须先于 `migrate deploy` 与任何清理执行。
- **测试库不存在**：由开发者预建，或确保测试账号具备 CREATEDB；否则 `migrate deploy` 明确失败，不静默跳过。
- **迁移授权库**：`db:migrate:new` 只连接 `SHADOW_DATABASE_URL`，不连接、不应用、不重置任何应用库；`DATABASE_URL` 指向何处不影响授权结果。shadow 库必须按“可丢弃”对待。
- **shadow 库**：`db:migrate:new` 要求显式 `SHADOW_DATABASE_URL`（缺失时脚本在调用 Prisma 前明确失败），且不得与 `DATABASE_URL` 相同；Prisma 会在该库回放迁移目录并重置其内容。
- **并行测试**：隔离机制必须跨 vitest worker 进程有效；仅进程内互斥不满足要求。
- **未迁移的库**：应用不做 schema 探测（D5），也不自动建表；部署步骤（entrypoint / 流水线 `migrate deploy`）应在启动前阻断，应用侧首次查询按 Prisma 原生错误失败。
- **数据库不存在**：`migrate deploy` 在权限允许时会尝试建库，失败则明确报错；正常部署应由 compose `POSTGRES_DB` 或管理员预先建库，不依赖应用的运行时能力。
- **多进程**：目录锁消失后，同一库多进程由 PG 并发控制；不再有“防双开”语义（这正是目标拓扑需要的）。
- **Windows 开发机**：移除 PGlite 原生依赖后安装面缩小；真实库测试需要可达的测试 PG（当前开发方式已满足）。
- **CI**：`CI=true` 或 `CI=1` 且未配置 `TEST_DATABASE_URL` 时真实库用例直接失败；非 CI 未配置时跳过并显示原因；配置后必须通过，禁止靠跳过掩盖失败。
- **迁移回滚**：Prisma 迁移为前向修复，不提供自动回滚；部署前备份/快照由部署流程负责，本 Spec 不引入回滚机制。

## 实施步骤（已确认，按此执行）

1. 数据层瘦身与 `DATABASE_URL` 必填校验（client / bootstrap / index / prisma.config）。
2. 迁移授权与 CLI 脚本改造（author-migration / cli-bootstrap / package scripts，含 `predev`、`pg` / `@types/pg` devDependency 与 Prisma 7 env 注入）。
3. 测试基座（`vitest.config.ts` globalSetup + helper）与 5 个真实库测试迁移。
4. 文档、`.env.example`、`.gitignore`、schema 注释同步。
5. 回写四个关联 Spec。
6. 全量验证：typecheck、lint、server / web 测试（串行）、真实 PG 启动冒烟、`db:migrate:new` 一次迁移授权、`migrate deploy` 一次应用、无 DATABASE_URL 时 `prisma generate` 冒烟。

## 验收标准

1. 运行时代码/脚本/配置无 PGlite 导入或可执行路径：`grep -ri "pglite" server scripts vitest.config.ts prisma.config.ts package.json prisma/schema.prisma` 仅命中注释、错误文案、Spec 链接与生成客户端的 inlineSchema；三个包 `npm ls <pkg> --depth=0` 为空（`prisma -> @prisma/dev -> @electric-sql/pglite` 传递依赖允许保留）。
2. 缺失、空串、`file:`、非 postgres 前缀的 `DATABASE_URL` → 启动失败，错误文案明确；合法 `postgres://` → 正常启动；bootstrap 日志无 `mode` 字段、无迁移应用记录。
3. 服务器模式冒烟通过：登录、上传（含视频 ingest）、生成任务入队与查询（沿用现有测试或 NAS 环境）。
4. 真实库测试：设置 `TEST_DATABASE_URL` 时 5 个文件全部通过；本地未设置时按门控跳过且显示原因，CI 未设置时失败；误配非测试库时 globalSetup 在迁移前硬失败且未执行任何清理。
5. `npm run db:migrate:new -- <name>` 在 shadow 库可用时生成迁移目录并重新生成客户端；`DATABASE_URL` 不可达时仍能生成（证明确实不触碰应用库）；schema 无变化时输出“无差异”且不创建目录；`db:migrate:deploy` 可应用该迁移。
6. README / `.env.example` 不再出现“不设置 DATABASE_URL 即本地模式”的表述；按文档从零可跑通（设置 URL → migrate deploy → 启动）。
7. typecheck、lint、server 测试、web 测试串行通过；测试数量变化（真实库用例在无 `TEST_DATABASE_URL` 时跳过）在交付报告中如实列出。
8. 生产 compose / entrypoint 行为无变化（对照现有文件）。
9. 无 `DATABASE_URL` 的环境下 `prisma generate`（postinstall / 镜像构建）成功，`prisma.config.ts` 不因缺少连接串阻断代码生成。
10. 在未 export `DATABASE_URL` 的干净 shell 中 `npm run db:migrate:deploy` 能从 `.env` 读取连接串并成功（Prisma 7 不自动加载 `.env`）。

## 已确认决策（2026-10-21，用户「D1–D6 全按推荐」）

**D1 — 测试库策略（已确认）。** `TEST_DATABASE_URL` 自门控 + 专用测试库：非 CI 环境未设置时真实库用例整体跳过（与 `TEST_REDIS_URL` 一致），CI 环境（`CI=true` 或 `CI=1`）未设置时直接失败；不引入 testcontainers。

**D2 — 测试文件隔离（已确认）。** PG 会话级 advisory lock（独立连接持锁至文件结束）+ 每个文件开始前 `TRUNCATE ... RESTART IDENTITY CASCADE` 清空 public 表；`_prisma_migrations` 必须排除。直连驱动 `pg` 与类型 `@types/pg` 显式加入 devDependencies，不依赖传递依赖。

**D3 — 迁移授权（已确认；2026-10-21 复审后修订）。** 初版方案为 `prisma migrate dev --create-only --name <name>`。复审发现该命令会连接应用库、drift 时可能提示 reset，`NODE_ENV` 无法区分开发与共享 staging，且 Prisma 7.10 在无差异时仍创建空迁移目录。改为官方 `prisma migrate diff --from-migrations --to-schema --script`（迁移目录回放到 shadow 库 + schema 差分）：授权阶段完全不触碰应用库，无 reset 提示、无空目录；本地与 CI 使用同一路径。

**D4 — 零安装开发体验（已确认）。** 开发必须提供 PG（当前开发方式已满足）；不保留“无 DATABASE_URL 零安装”路径。

**D5 — 启动期迁移检查（已确认）。** 应用不做 schema 探测；未迁移库由部署步骤（entrypoint / 流水线 `migrate deploy`）在启动前阻断，应用侧首次查询按 Prisma 原生错误失败；不引入 `prisma migrate status` 启动检查。

**D6 — 开发期迁移执行（已确认）。** 新增 `db:migrate:deploy` 脚本，并在 `dev` 前增加 `predev` 钩子自动执行（幂等；迁移失败即启动失败）。

## 当前状态

已确认（2026-10-21，用户确认 D1–D6 全按推荐；D3 已于同日复审后修订）；实施中：代码、测试与文档变更已提交，真实库、迁移授权与全量测试验收已通过；四轮代码审查发现的问题均已按根因修复并复验；剩余业务冒烟。

### 已完成（2026-10-21 提交）

- **单一运行时**：新增 `server/core/database/connection-string.ts`（`assertDatabaseUrl` / `describeDatabaseTarget` / `parsePostgresDatabaseTarget` / `isSameDatabaseTarget` / `assertDistinctDatabaseTargets`）；`client.ts` 删除 PGlite 分支、目录锁、`ensureLocalMigrations`，保留惰性 Proxy 与连接串键控缓存；删除 `migrate.ts`；bootstrap 只校验连接串并记录 `target`；关停统一为 `closeDatabase`。
- **迁移链路**：新增 `db:migrate:deploy` 与 `predev`；`db:migrate:new` 改为 `prisma migrate diff --from-migrations --to-schema --script`（只读 shadow 库，不触碰应用库），生成迁移后执行一次 `prisma generate`；`prisma.config.ts` 条件提供 datasource、`SHADOW_DATABASE_URL`；移除三个 PGlite 直接依赖，显式加入 `pg` / `@types/pg`；Prisma CLI 调用收敛到 `scripts/lib/prisma-cli.mts`。
- **测试基座**：`vitest.config.ts` 注册 globalSetup（安全校验 + 测试库 `migrate deploy`）；新增 `test-database.ts`（会话级 advisory lock + `TRUNCATE ... RESTART IDENTITY CASCADE` + `DATABASE_URL` / `LOG_LEVEL` 切换与恢复）；5 个真实库测试迁移到 `TEST_DATABASE_URL`；新增 `connection-string.test.ts` 21 个用例。
- **文档与 Spec**：README、`.env.example`、`.gitignore`、`prisma/schema.prisma` 注释同步；四个关联 Spec 回写。

### 已验证事实（2026-10-21）

- 测试库 `noxrea_test` 与 shadow 库 `noxrea_shadow` 已在 NAS PostgreSQL（10.10.10.2:9832）创建并归 `noxrea` 所有；`TEST_DATABASE_URL` / `SHADOW_DATABASE_URL` 已写入本地 `.env`（不提交）。
- **真实库测试**：5 个文件 64/64 通过（settings、user、user-avatar-ledger、asset-folder-constraint、file-ref-ledger-bulk）；第四轮复审后连同 `connection-string.test.ts` 复跑 6 files / 85 tests 通过。
- **全量 server 测试**（单 worker，测试库已配置，第四轮复审后复跑）：86 files / 944 tests 通过；1 file / 9 tests（Redis 集成）按门控跳过。此前复跑期间 `video-frames` 的截断尾帧用例出现过一次已知 ffprobe 瞬时空 section（单文件 15/15 与再次全量均通过，未改代码）。
- **web 测试**（第二轮复审后复跑）：127 files / 934 tests 通过（本轮无 web 代码变更）。
- **第二轮复审机制验证**：`db:migrate:new` 无差异路径不创建目录、无 staging 残留；临时字段的成功路径生成 `ALTER TABLE` 迁移并重新生成客户端，随后删除迁移目录并恢复 schema；删除连接参数黑名单后，`pg` 实测忽略 `schema` / `connection_limit` / `pool_timeout`（真实库测试通过）。
- **第三轮复审机制验证**：`SHADOW_DATABASE_URL` 与 `DATABASE_URL` 指向同一库、仅查询参数不同时，`db:migrate:new` 与 `prisma.config.ts` 均在建立连接前拒绝（已实测）；无 URL 时 `prisma generate` 仍成功。
- **第四轮复审机制验证**：`prisma.config.ts` 在加载期拒绝非 postgres 的 `DATABASE_URL` 与 `SHADOW_DATABASE_URL`（分别实测），同库不同查询参数仍拒绝，无 URL 时 `prisma generate` 成功；`db:migrate:new` 使用基于 `repoRoot` 的绝对路径完成后无差异判定，未创建迁移目录或 staging 残留。
- `npm run typecheck` 通过；`npm run lint` 0 error（26 条既有 web `<img>` 警告）。
- **`db:migrate:new`（复审后机制）**：schema 无变化时输出“无差异”且不创建目录；临时增加字段的成功路径生成了 `ALTER TABLE` 迁移并重新生成客户端，随后删除迁移目录并恢复 schema（未应用临时迁移）。将 `DATABASE_URL` 指向不可达地址后仍能生成正确 SQL，证明授权只使用 shadow 库。`db:migrate:deploy` 对现有 5 条迁移幂等（`No pending migrations to apply.`）。
- **测试库误配保护**：将 `TEST_DATABASE_URL` 指向开发库 `noxrea` 时，globalSetup 在迁移部署前硬失败（“数据库名必须包含 test”），未执行任何迁移或清理。
- **CI 门控**：`CI=true` 或 `CI=1` 且未设置 `TEST_DATABASE_URL` 时 globalSetup 直接失败（已验证错误文案）；非 CI 未设置时真实库用例跳过（配置测试库前的全量 server 运行已验证）。
- 无 `DATABASE_URL` 时 `prisma generate` 成功；`db:migrate:deploy` 对开发库与测试库均幂等（`No pending migrations to apply.`）。
- 用户 dev server 热重载后 bootstrap 成功：`database_ready | target=pg noxrea@10.10.10.2:9832/noxrea`（无 `mode`），队列、S3、Worker、reconcile 均正常启动。
- `npm ls @electric-sql/pglite pglite-prisma-adapter prisma-pglite --depth=0` 为空；`@electric-sql/pglite@0.4.3` 仅作为 `prisma@7.10.0 -> @prisma/dev` 的传递依赖存在，运行时代码无导入或可执行路径。
- `grep -ri pglite` 在运行时代码/脚本/配置中仅剩注释、错误文案、Spec 链接与生成客户端的 inlineSchema。

### 实施中修复的问题

- **P2002 约束信息形态**：`@prisma/adapter-pg` 7.10 将 PostgreSQL 的 `error.constraint` 映射为 `constraint.index`（索引名），不填充 `fields`；原 helper 按列名匹配，导致用户名/未分类目录的唯一冲突无法识别。已改为按索引名匹配，并同步更新 `user.ts`、`asset.ts`、`assets.ts` 与真实库测试。
- **并发首注册双 admin**：PostgreSQL READ COMMITTED 下两个并发事务都可能读到 `count=0`，原 SQLite/PGlite 写串行化已不存在。`createUser` 增加事务级 `pg_advisory_xact_lock`，跨连接/跨实例串行化首注册判定。
- **迁移授权可能触碰应用库（复审）**：初版 `migrate dev --create-only` 会连接并可能重置应用库，`NODE_ENV` 无法区分开发与共享 staging，且无差异时仍生成空目录。已改为 `migrate diff --from-migrations --to-schema --script`（只读 shadow 库），并实证 `DATABASE_URL` 不可达时仍可生成 SQL；空差分直接判定“无差异”，不再需要删除空目录。
- **重负载测试超时连锁**：5 万来源用例在全量单 worker 下会击穿 30s 上限，超时后未完成的查询持有文件级 advisory lock，导致后续文件连锁超时；用例超时上限调整为 120s（数据准备约 18–20s）。
- **重复实现（复审）**：Prisma CLI 定位/执行在迁移脚本与 globalSetup 三处重复 → 收敛为 `scripts/lib/prisma-cli.mts`；5 个真实库测试重复维护 `LOG_LEVEL` 保存/恢复 → 收敛到 `setupTestDatabase`；`client.ts` 同时 re-export `assertDatabaseUrl` 并包装日志描述 → 删除转出与包装，bootstrap / CLI 直接使用 `connection-string`；`prisma.config.ts` 内联连接串前缀判断 → 复用 `isPostgresDatabaseUrl`。
- **索引名字面量散落（复审）**：P2002 匹配依赖的索引名收敛到 `server/core/database/constraint-names.ts`；真实库测试保留字面量，用于锁定数据库中的实际索引名。
- **`data/` 失去 ignore 保护（复审）**：`.gitignore` 删除 `data/` 后，遗留 PGlite 目录重新变为未跟踪文件（`git add -A` 会误提交）。现保留根锚定 `/data/`；目录本身可由开发者删除。
- **第二轮复审（2026-10-21）**：迁移目录改为“同卷临时目录写入 + 整体改名”，写文件失败不再遗留空目录；`describeDatabaseTarget` 复用统一解析入口，未校验输入直接得到可行动错误（新增 3 个回归用例）；测试基座删除 Prisma 连接参数黑名单——`pg` 只读取自身支持的字段，已实测 `schema` / `connection_limit` / `pool_timeout` 被忽略，无需改写连接串；Spec 回写范围补充 `system-settings-db.md`，R1 文案与实现对齐。
- **第三轮复审（2026-10-21）**：shadow / 测试库同库校验统一为 `connection-string.ts` 的 host/port/database identity 比较（原全串相等可被协议写法或查询参数绕过），新增 3 个同库判定/非法编码回归用例；`test-database.ts` 复用同一解析入口；`client.ts` 缓存键拼接收敛为单函数；Spec 状态行、R4/R5.2/R6 文案与实现对齐，补记迁移名白名单与 helper 更名。
- **第四轮复审（2026-10-21）**：同库守卫收敛为 `assertDistinctDatabaseTargets`，`prisma.config.ts` / `author-migration.mts` / 测试基座共用判定与文案；`prisma.config.ts` 对已设置的 URL 做格式校验，非 postgres 的 shadow 不再透传给 CLI；`DatabaseIdentity` / `parsePostgresDatabaseIdentity` 与 `...Target` 命名统一为 Target；`client.ts` 删除双模式遗留的 `pg:` 缓存键前缀；仓库根路径移到 `scripts/lib/paths.mts`，恢复 `prisma-cli.mts` 的模块边界；迁移授权改用绝对路径常量并改进迁移名错误文案；测试环境保存/恢复改用 `vi.stubEnv` 与局部 `restoreEnv`；Spec 用例数、CI 取值与空差分判定同步。

### 待完成（验收缺口）

- **服务器模式业务冒烟**（验收第 3 条）：已验证启动链路与测试套件，登录 / 上传 / 生成任务全链路未走查。全部验收通过（含本项人工走查）后，方可将状态更新为「已实现」。

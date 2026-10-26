# Spec：数据库统一 PostgreSQL 方言与双模式部署

状态：已实现

## 当前状态

**已实现**（2026-10-15 用户逐项确认 Q1–Q3，见决策 D7–D9；2026-10-26 用户验收确认）。实现已完成并提交；PGlite 本地模式已由 [pglite-removal.md](pglite-removal.md) 移除，现行部署为外置 PostgreSQL 单一运行时。应用容器 compose（ghcr 镜像 + entrypoint）全链路仍未在 docker 部署机实测，保留为遗留项。

实现进度（2026-10-15）：阶段 1 全部完成——Prisma 7.10.0 + `prisma-client` 生成器；双模式工厂（client.ts：按连接目标缓存实例、惰性初始化、本地模式跨进程数据目录锁 `noxrea.lock` 防 PGlite 双开互毁）；迁移 runner（migrate.ts，语义对齐 migrate deploy，记账与真 Prisma 兼容）；PG 基线迁移 `20261015061549_baseline`（createPgliteMigration 授权链路生成，`npm run db:migrate:new` 封装于 scripts/db/author-migration.mts）；dev 数据一次性搬迁完成（5507 行全表对账一致，序列重同步，API 冒烟 200）；测试基座迁 PG 方言。**Gate 1 于实装版本 0.5.10 回归通过**（SIGKILL 5 轮零丢失零缺洞 / 60 小事务 exit-不-close / 单大事务 5500 行 exit-不-close 全部存活；测试件在 G:/.Cache/temp/nox-gate1-recheck/gate1.mjs）；**Gate 2 正式判定通过**（bulk 套件 15.84s ≤ 基线 6.31s×3=18.9s，倍率 2.51）。阶段 2 文件就位（docker-compose.nas.yml 双容器 + entrypoint 等 PG→migrate deploy；本机无 docker 未实测）。**遗留清理已执行（2026-10-15，用户授权「不需要向后兼容」）**：删除 dev.db×3 / 根目录 _shadow_tmp.db / 一次性搬迁脚本 / 4 个排查期临时诊断脚本；卸载 better-sqlite3 与 @types/better-sqlite3；删除 getLocalPglite（唯一调用方即搬迁脚本）与 isUncategorizedFolderUniqueError（两个方言下 asset_folders 均无唯一索引，catch 永不命中）。**无约束竞态已修复（用户放行后实施，2026-10-15）**：手写迁移 `20261015213000_uncategorized_unique` 建 PG 部分唯一索引 `asset_folders(user_id, scope) WHERE kind='uncategorized'`（Prisma schema 无法表达，已实证 `db:migrate:new` 差分「No changes detected」——schema 引擎感知不到部分索引，未来授权不会生成 DROP 它的迁移）；crud/asset.ts 恢复竞态守卫（现在约束真实存在，撞索引回读并发方目录）；新增真实库回归测试 asset-folder-constraint.test.ts（3 用例：同用户同 scope 二次创建拒绝且冲突索引 asset_folders_uncategorized_key（列 user_id+scope）、普通目录不受限、跨 scope 互不影响）；本地 dev 库经真实启动应用迁移（local_migrations_applied 日志 + 完整 bootstrap）。审查另修复：closeLocalDatabase 先放锁后 close 的关停顺序（checkpoint 未完成时他进程可打开同目录，正是锁要防的场景）；.dockerignore 未排除本地 data/（PGlite 真实数据会被打进镜像层）。README 同步双模式现实（快速开始、常用命令、env 表、系统设置修改方式、Docker 部署、删除 SQLite 时代「升级旧版数据库」节、持久化表）。实现过程中发现并修复：driver adapter 下 P2002 约束信息在 meta.driverAdapterError（meta.target 不存在）→ 统一收敛为 core/database/errors.ts；2026-10-21 核实 adapter-pg 7.10 的约束形态为 constraint.index（不填充 fields），helper 已改为按索引名匹配（见 pglite-removal.md）；vitest 单 fork 跨文件 globalThis 实例泄漏 → 按连接目标键控；PGlite 同目录多实例无锁互斥（本次 dev 数据曾因此丢失后重做）→ 数据目录锁 + 优雅关停 close checkpoint。

增量（2026-10-21，[pglite-removal.md](pglite-removal.md)）：D3（本地模式 = PGlite）与 D4（Plan B 嵌入式 PG）已被取代——PGlite 本地模式整体移除，应用只保留外置 PostgreSQL 单一运行时；本地迁移 runner（`server/core/database/migrate.ts`）删除，迁移应用统一走 `prisma migrate deploy`。本 Spec 的单方言、Prisma 7、服务器模式部署结论不变。同日复审后，`db:migrate:new` 由 `migrate dev --create-only` 改为 `prisma migrate diff --from-migrations --to-schema --script`（只回放 shadow 库，不连接应用库）；已实测该路径对部分唯一索引不会生成 DROP 语句，前文“未来授权不会生成 DROP 它的迁移”的结论继续成立。

## 目标

1. 全链路（开发、测试、服务器部署）只使用一种 SQL 方言：PostgreSQL。
2. 本地/Windows 零安装模式（含日常开发）与服务器模式共用同一份 schema、同一份迁移文件、同一套业务代码，仅数据层载体不同。
3. 同窗口完成 Prisma 6.19.3 → 7 升级，消除 Rust 查询引擎与 Dockerfile 的 binaryTargets 变通。
4. 保留向嵌入式真 PG 切换的既定路径（Plan B），切换成本收敛在数据层单点。

## 已确认决策（对话记录，2026-10-15）

| # | 决策 |
| --- | --- |
| D1 | 生产部署（含 NAS）使用 PostgreSQL；从未实际部署过 NAS，不存在存量服务器数据，不做向后兼容 |
| D2 | 单方言：SQLite 退役，不保留双方言支持 |
| D3 | 本地模式载体 = PGlite（进程内 PG，npm 依赖）；三个验收 gate 不过则切 Plan B |
| D4 | Plan B = 随包嵌入式真 PG 二进制（initdb + 子进程），切换路径见「Plan B」节 |
| D5 | Prisma 7 升级与本次改造同窗口完成（7.10.0 stable） |
| D6 | 开发者本机 dev.db 内容做一次性迁移（脚本跑一次即弃），此后不存在任何迁移概念 |
| D7 | 生成器采用 v7 原生 `prisma-client`（非过渡形态的 `prisma-client-js`），接受 14 处导入点的机械修改 |
| D8 | 阶段 2（NAS compose + entrypoint）随本期一起实施 |
| D9 | Gate 2 阈值定为 **×3**：bulk 测试在 PGlite 上的耗时 ≤ 迁移时实测的 SQLite 基线 ×3，超过即触发 Plan B |

## 范围

**范围内**：Prisma 7 升级；schema 切 postgres；双模式数据层工厂；本地模式启动迁移 runner；一次性 dev 数据搬迁脚本；服务器模式 NAS compose 与 entrypoint；测试基座迁移到 PG 方言。

**范围外**：多实例部署与分布式协调（Redis 等）；PG jsonb 等方言特性引入；web 前端任何改动；注册/登录等业务逻辑。

## 技术方案

### 1. 依赖与生成（阶段 1）

- `prisma` / `@prisma/client` 升至 7.10.x；新增 `@electric-sql/pglite`、`pglite-prisma-adapter`（0.7.x）、`@prisma/adapter-pg`（服务器模式）。
- `prisma/schema.prisma`：`provider = "postgres"`；删除 `binaryTargets`（引擎随 v7 消亡）；datasource 不再声明 `url`（v7 实测要求，连接配置移入 prisma.config.ts）。
- 新增 `prisma.config.ts`（`defineConfig`）：`migrate.adapter` 指向 PGlite，用于开发期迁移授权。
- 生成器：v7 原生 `prisma-client`（D7），输出目录 `server/core/database/generated/`；`server` 下 14 个 `@prisma/client` 导入点改为从生成目录导入（机械修改）。

### 2. 双模式数据层（阶段 1）

`server/core/database/client.ts` 改造为工厂：

- `DATABASE_URL` 为 `postgres://` → `adapter-pg`（服务器模式）；
- 未设置或 `pglite:` → PGlite 实例 + `pglite-prisma-adapter`（本地模式，数据目录位于应用数据目录，Windows 下随应用数据位置约定）。
- 两种模式返回同一业务类型；类型收敛集中在工厂文件内。
- 删除 `applyPragmas` 与一切 SQLite PRAGMA 逻辑。

### 3. 迁移 runner（阶段 1，本地模式专用）

- 语义对齐 `prisma migrate deploy`：按目录名序应用 `prisma/migrations` 下未应用迁移；每个迁移一个事务；写 `_prisma_migrations` 记账（含 sha256 checksum）；已应用迁移 checksum 不符即拒绝启动。
- 服务器模式不使用 runner，走原生 `prisma migrate deploy`。
- **单一演进源约束**：两个模式消费同一份 `prisma/migrations`，禁止任何一方生成方言分叉。
- 本地模式启动顺序：打开 PGlite → runner 应用增量 → 启动服务。
- 失败恢复：迁移失败整体回滚（PG DDL 事务性）、不写记账、进程报错退出；修复后重跑幂等。

### 4. 迁移授权工作流（开发期，阶段 1）

改 schema → `createPgliteMigration`（prisma-pglite 导出 API；其 CLI bin 在 Windows 有 argv bug，统一走 API 封装的 npm script）→ 提交生成的迁移文件。全程无需 docker 或任何数据库服务。

### 5. 一次性 dev 数据搬迁（阶段 1 末尾，一次性）

- 脚本：旧 SQLite client（切换前生成物）读 `dev.db` 全表 → 新 PGlite client 按依赖序写入，保留全部 ID 与 JSON TEXT 原文。
- 跑一次、验收行数一致后归档/删除脚本与 `dev.db`、`prisma/dev.db*`、根目录 `_shadow_tmp.db`。

### 6. 服务器模式部署（阶段 2）

- `docker-compose.nas.yml` 增加 `postgres:17-alpine` 服务（healthcheck `pg_isready`、独立数据卷）+ 一键脚本生成密码写入 `.env`。
- entrypoint：等待 PG 就绪 → `prisma migrate deploy` → 起服务。v7 下迁移命令的连接取自 `prisma.config.ts` 的 `datasource.url`（写为 `env("DATABASE_URL")`，值来自容器环境变量，entrypoint 已 source .env，模式已经 7.10 类型定义确认）。
- PG 内存调优（2G 环境）：`shared_buffers=128MB`、`max_connections=20`、autovacuum 收敛；应用侧连接串 `connection_limit=5~10`。
- 删除 SQLite 相关默认值（`file:` URL 等）。

### 7. 测试基座（阶段 1 内）

- vitest 从 SQLite 文件改为 PGlite 实例（每测试文件独立实例或内存实例）+ runner 应用基线迁移。
- 既有 bulk 测试（5 万行级）迁移后重跑，作为 Gate 2 的基准。

## 异常与边界

1. **PGlite 单连接串行**是本地模式边界：定位为单用户本地使用；多用户场景一律走服务器模式（README 部署文档明示）。
2. **迁移失败**：本地模式拒绝启动并输出可读错误（用户可求助的单一错误口径）；服务器模式沿用 `migrate deploy` 原生语义。
3. **checksum 校验失败**（迁移文件被手改）：拒绝启动，报错指明迁移名。
4. **PGlite 版本升级**：产品线锁定 PG 17；PGlite 大版本升级涉及数据目录格式时，须提供 dump→import 路径后再升级依赖。

## 验收标准（gate）

**Gate 1（耐久性）**：写入负载中 `kill -9` 应用进程 → 重开数据目录 → 无损坏、已提交数据完整、WAL 重放干净。不过则启动 Plan B 切换。
　**已预验证（2026-10-15，NTFS 实测）**：5 轮 SIGKILL（含同目录续写重启场景），每轮已提交批次精确存活、无半批、无缺洞，重开耗时 130~290ms。阶段 1 以回归形式复测。
**Gate 2（性能，D9 已定阈值）**：既有 bulk 测试在 PGlite 上运行时间 ≤ 迁移时实测的 SQLite 基线 ×3。不过则启动 Plan B 切换。
　**已预检（2026-10-15，同规模微基准）**：1 万来源集合运算（20 片 UPDATE...FROM+DELETE）578ms；50k 行 LIKE 探波单次 ~6ms；逐 hash 递减分布与引用分布吻合。正式判定仍以阶段 1 真实测试套件为准。
**Gate 3（维护）**：adapter 依赖停维护即评估 fork（约 500 行薄封装，已确认可fork）。
　**维护状态盘点（2026-10-15）**：`prisma-pglite` 最近发版 2026-10-01（活跃）；`@electric-sql/pglite` 0.5.10，2026-10-14（高频活跃）；`pglite-prisma-adapter` 最近发版 2026-01-17（约 9 个月空窗，但其为运行时薄封装、性质稳定，fork 兜底已评估）。
**阶段 1 验收**：全量测试通过（PG 方言）；`createPgliteMigration` 授权 → runner 应用 → 本地 CRUD 闭环可用；dev 数据搬迁完成且行数对账一致。
**阶段 2 验收**：NAS compose 一键起停；`migrate deploy` 幂等；runner 记账与真 `migrate deploy` 对同一 PG 库互通（用真 PG 对照验证记账格式兼容）。

**阶段 2 验证结果（2026-10-15，NAS 实测）**：
- **migrate deploy 幂等**：✅ 首次应用基线（12 表 + 记账），复跑 "No pending migrations"。
- **记账互通（真 PG 对照）**：✅ 双向验证——① checksum 算法一致：真 Prisma 写入的记账 checksum 与 runner 的 sha256 逐位相同（d2761aaa…）；② runner 语义（建记账表 DDL + sha256 记账行）写入的库，被真 `prisma migrate deploy` 识别为已全部应用（"No pending migrations"）。两套应用器可互换接管同一库。
- **服务器模式端到端**：✅ `mode=server` 启动（adapter-pg 连 NAS 真 PG）→ 注册用户（首注册 admin 判定正常）→ JWT 鉴权 API 读列表 200 → API 建项目 → 数据落真 PG（users=1、canvas_projects=1、system_settings=40 键播种）。
- **NAS PG 实例**：用户自建 postgres:17-alpine（10.10.10.2:9832，容器名 postgres，LAN 映射端口；调优参数实测生效）。项目专用账号：用户 noxrea / 库 noxrea，密码在会话中交付未入库。冒烟数据与互通对照库 noxrea_interop 已于 2026-10-15 应用户要求清除（DROP 后重建空库，用户 noxrea 保留），当前为全新空库待正式部署。
- **未实测项**：应用容器 compose（ghcr 镜像 + entrypoint 全链路）需在有 docker 的部署机上起一次；本机 docker 不可用。

## Plan B：切换嵌入式真 PG（触发：任一 gate 不过，或未来主动升级）

改动收敛在数据层单点：工厂 adapter 换 `@prisma/adapter-pg`（指向随包 initdb 的本机数据目录）；删除 runner，启动改用原生 `migrate deploy`；新增 Windows 进程管理模块（initdb 首启、spawn、`pg_ctl stop` 优雅关停、孤儿/stale lock 清理）；存量数据经 SQL dump → import 迁移。方言、schema、迁移文件、业务代码零改动。

## 待确认事项

无。Q1–Q3 已于 2026-10-15 由用户确认（D7–D9）。

## 风险清单（2026-10-15 处理结果）

1. ~~社区包维护风险~~ **已量化并兜底**：`prisma-pglite` 活跃（两周前发版）、`@electric-sql/pglite` 高频活跃（昨日发版）；仅 `pglite-prisma-adapter` 约 9 个月未发版——运行时薄封装（约 500 行 dist），fork 成本已评估，Gate 3 + Plan B 兜底不变。
2. ~~NTFS kill -9 耐久性未验证~~ **已实证通过**（见 Gate 1 预验证）：5 轮 SIGKILL 零数据丢失、零损坏、WAL 重放 130~290ms。
3. ~~Prisma 7 破坏性变化未逐一核对~~ **已核对核心清单**（实证 + 7.10 类型定义）：
   - schema `datasource url` 移除（CLI 实测拒绝）；连接配置移入 `prisma.config.ts`；
   - 配置文件为 `defineConfig`（`@prisma/config`）；
   - `driverAdapters` 默认启用（preview 标记弃用）；
   - **7.10 官方 `PrismaConfig` 无 `migrate.adapter` 钩子**（社区 README 该写法已过时）：迁移命令连接统一取自 `config.datasource.url`（配 `env()` 助手，值来自进程环境变量）→ 服务器模式 entrypoint 只需保证 `DATABASE_URL` 在环境中即可，模式确认；
   - `prisma-client-js` 生成器 7.10 实测可用；
   - 官方升级指南页面本环境无法抓取（客户端渲染 + raw.githubusercontent 被网络策略拦截），残余差异以阶段 1 的 typecheck + 全量测试实证兜底。
4. ~~schema-engine-wasm prerelease 固定版本~~ **已确认无碍**：`prisma-pglite` 锁定的 `7.10.0-4.0edf323` 与 Prisma 7.10.0 匹配，且该包仅影响开发期授权命令，不影响运行时与服务器模式。

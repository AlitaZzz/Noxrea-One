# Server CRUD/Service Boundary（服务端 CRUD 与 Service 分层收敛）

状态：已实现（2026-11-04 起草；2026-11-04 修订：补全 `http → crud` 白名单、澄清聚合与账本边界、修正事务计数；2026-11-04 二次修订：按审核结论修正终态写入原子性、账本批量原语改名、画布写原语签名与增量合并归属；2026-11-04 三次修订：按二次审核结论修正画布写原语返回值与 P2025 语义、`applyCanvasDelta` 合并语义、账本调用方清单、头像校验链、终态返回投影与 `adjustFileRefCountTx` 改名；2026-11-04 四次修订：按三次审核结论修正封面账本条件写入与 P2025 早退、全量/增量统一的 revision 冲突判定与原子递增、内容账本短路；2026-11-04 用户确认；2026-11-09 用户确认全部验收并指示改为「已实现」，实现随本次提交入库）

## 背景

2026-11-04 的服务端结构盘点确认：HTTP 路由整体是薄的“鉴权 → 校验 → 调用 → 错误映射”层，`services` 承担队列、存储、任务、Agent、网关等编排职责，但 `crud` 已不是单向的数据访问层：多个 `crud` 模块直接导入 `services`，同时 `services` 又导入 `crud`，形成包级双向依赖。

结果是：

- 依赖方向无法用一条规则约束，新增代码只能靠人工判断“这次该放 crud 还是 service”。
- `crud/asset` 同时承担事务、文件引用账本、目录计数与业务错误语义，名称与职责不符。
- 修改 `services/storage/file-ref-ledger`、`services/tasks/watcher` 等模块会反向影响 `crud`，事务边界与事件广播的归属难以从目录结构判断。
- `server/core/bootstrap.ts` 作为启动引导导入 `services`，使 `core` 也不是纯基础设施层。

本 Spec 的目标是建立一条可检查的单向依赖规则，并把已经越界的用例移动到正确层级；不改变任何 API、数据库结构、事务语义或运行时行为。

## 现状与已验证事实

### `crud → services` 的实际边

- `server/crud/asset.ts` 导入 `@server/services/storage/file-ref-ledger`（`replaceSourceFileRef`、`removeSourceFileRefsBatch`），用于资产删除/更新时维护引用账本。
- `server/crud/canvas.ts` 导入：
  - `@server/services/canvas/editor-lease`（`withProjectGate`、`isCurrentLease`）
  - `@server/services/canvas/extract-hashes`（`extractHashCountsFromCanvas`、`hashCountsEqual`）
  - `@server/services/canvas/project-summary`（`deriveCanvasSummary`、`toProjectSummary`）
  - `@server/services/storage/file-ref-ledger`（`replaceSourceFileRefs`、`replaceSourceFileRef`、`removeSourceFileRefs`）
- `server/crud/task.ts` 导入 `@server/services/tasks/event-bus`（`publishTaskTerminal`，运行时）与 `@server/services/tasks/watcher`（`TerminalTaskState`，仅类型）。
- `server/crud/user.ts` 导入 `@server/services/storage/file-ref-ledger`（`replaceSourceFileRef`）与 `@server/services/storage/ownership`（`isKeyOwner`）。

### `services → crud` 的实际边

以下 13 个 service 文件导入 `@server/crud/*`：

`server/services/agent/completion.ts`、`server/services/capabilities/llm/service.ts`、`server/services/storage/file-ref-ledger.ts`、`server/services/storage/persist.ts`、`server/services/tasks/manager.ts`、`server/services/tasks/upstream-cancel.ts`、`server/services/tasks/watcher.ts`、`server/services/worker/context.ts`、`server/services/worker/download-results.ts`、`server/services/worker/executor.ts`、`server/services/worker/handler.ts`、`server/services/worker/poll-attempt.ts`、`server/services/worker/reconcile.ts`。

其中 `services/storage/file-ref-ledger.ts` 反向导入 `@server/crud/file`，是包级循环的直接证据。

### 其它已确认事实

- `server/crud` 与 `server/services` 当前都没有导入 `@server/http`。问题集中在 `crud ↔ services` 与 `core → services`。
- 事务现状：`server/crud` 与 `server/services` 共 19 处 `prisma.$transaction`（`crud` 18 处，`services/storage/gc.ts` 1 处；计数按实际调用点，不按文件数）；另有 `server/core/settings/index.ts` 1 处，不属于本 Spec 的 `crud`/`services` 统计范围。没有统一的 `withTransaction` 包装或 `TransactionClient` 命名约定，事务内原语（如 `deleteAssetItemsTx`、账本函数）靠手工传递 `Prisma.TransactionClient`。
- 错误现状：`AssetOperationError`（`crud/asset`）、`CanvasRevisionConflictError` / `CanvasCoverKeyError` / `CanvasLeaseLostError`（`crud/canvas`）、`UserAvatarKeyError`（`crud/user`）分别由路由映射；`UserAvatarKeyError` 映射 422，`CanvasRevisionConflictError` / `CanvasLeaseLostError` 映射 409，`CanvasCoverKeyError` 映射 422，`AssetOperationError` 按 code 映射 400/403/404；重复来源的 409 `assets.duplicate_file_key` 由单条创建路由对 CRUD 返回空 items 直接返回，不属于该错误类。
- 路由测试现状：`server/__tests__/http/routes/{assets,canvas}.test.ts` 直接 mock/import crud 的错误类与写函数；写用例上移后，这些 mock 路径与断言必须同步迁移。
- `server/core/bootstrap.ts` 导入 `services/worker/queue`、`services/worker/worker`，并动态导入 `services/gateway/registry`、`services/storage/service`、`services/storage/workspace`、`services/storage/gc`；唯一调用方是 `server/index.ts`。
- `http/routes/assets.ts` 将 `AssetOperationError` 映射为 HTTP 错误；`crud/asset.ts` 在目录不存在、受保护目录、资产不存在、非法文件 key 等事务内不变量处抛出该错误。`deleteAssetItemsTx` 是资产删除的事务内辅助函数。
- `updateUser` 当前在单事务内更新用户行并整替 avatar 账本；仅当 `isActive` 实际出现在更新字段中时，事务提交后调用 `invalidateAuthSnapshot(user)`，头像/主题/语言变更不触发。该调用没有 catch：快照失效失败会让请求失败，但用户行已提交。迁移后必须保持这一提交后语义。
- 现有服务端测试：`server/__tests__/crud/{asset,canvas,task,user,user-avatar-ledger,user-auth-snapshot}.test.ts`，以及 `server/__tests__/services/storage/file-ref-ledger*.test.ts`、`server/__tests__/services/canvas/{extract-hashes,project-summary}.test.ts` 等；暂无架构边界测试。
- 根 `vitest.config.ts` 只收集 `server/**/*.test.ts`；服务端检查与 web 检查必须串行执行。

## 目标

1. 建立并文档化单向依赖：`http → services → crud → core`；允许 `http → crud` 仅用于简单的单聚合读/写。
2. 让 `crud` 只依赖 `core`、`schemas`、`utils`、`shared` 与其它 `crud`，不再依赖 `services` 或 `http`。
3. 让 `services` 只依赖 `crud`、`core`、`schemas`、`utils`、`shared` 与其它 `services`，不再依赖 `http`。
4. 让 `core` 只承担基础设施与启动前配置；不依赖 `crud`、`services`、`http`。进程组装根（`server/index.ts` 与 `server/bootstrap.ts`）显式豁免。
5. 用自动化架构测试锁定上述方向，防止回归。
6. 保持现有 HTTP 契约、数据库结构、事务边界、错误码、SSE 事件与并发语义不变（例外：`createProject` 按 [web-module-contracts.md](web-module-contracts.md) 规则 1（项目写互斥与项目 API 拆分）的已确认契约只接收名称、不返回画布内容）。

## 范围

- `server/crud/asset.ts`、`canvas.ts`、`task.ts`、`user.ts` 的依赖收敛。
- `server/services/storage/file-ref-ledger.ts` 的下沉。
- `server/services/canvas/{extract-hashes,project-summary}.ts` 中纯函数的归位。
- `server/services/canvas/project-write.ts`、`server/services/user/update-profile.ts`、`server/services/tasks/terminal.ts` 等新用例模块。
- `server/core/bootstrap.ts` 的移动与 `server/index.ts` 导入更新。
- `server/http/routes/{agent,assets,auth,canvas,generate,model-config,models}.ts` 的导入核对；其中 `agent`、`model-config`、`models` 只登记白名单，不改变行为或拆分模块。
- 受影响的 `server/__tests__` 路径与 mock；新增架构边界测试。

## 非目标

- 不修改数据库 schema，不新增迁移，不改表、列、索引或约束。
- 不修改任何 HTTP 路径、请求/响应结构、状态码、错误码或 SSE 事件格式（`createProject` 除外，见目标 6 与 [web-module-contracts.md](web-module-contracts.md) 规则 1（项目写互斥与项目 API 拆分））。
- 不修改事务边界、租约/fencing 语义、引用账本算法、任务状态机或事件发布时序。
- 不把 `crud` 重命名为 `repository`，不引入新的 ORM/查询框架。
- 不把所有 `crud` 写操作迁到 `services`；`crud` 仍可承担单聚合事务写入。
- 不重写 `crud/asset` 的资产聚合逻辑；本期只消除其 `services` 依赖。
- 不为 `agent`、`model-config`、`models` 路由新增 service；这些路由的单聚合读写保留在 `crud`，只纳入白名单。
- 不改动队列、网关、Agent、存储后端的内部实现。
- 不保留旧路径的兼容导出；所有调用方直接迁移。

## 分层定义与依赖规则

| 层 | 职责 | 允许导入 | 禁止导入 |
| --- | --- | --- | --- |
| `http` | 请求边界：鉴权、Zod 校验、调用下层、HTTP 错误映射、响应组装 | `services`、`crud`、`core`、`schemas`、`utils`、`shared` | 无（入口层） |
| `services` | 用例编排：跨聚合事务、租约、事件广播、队列、外部 I/O、存储/Agent/网关流程 | `crud`、`core`、`schemas`、`utils`、`shared`、其它 `services` | `http` |
| `crud` | 数据访问 + 单聚合事务内不变量；返回领域行/错误，不发布事件、不调用外部服务 | `core`、`schemas`、`utils`、`shared`、其它 `crud` | `services`、`http` |
| `core` | 配置、数据库客户端、日志、Redis、限流、HTTP 客户端等基础设施 | `core`、`schemas`、`utils`、`shared` | `crud`、`services`、`http` |

补充规则：

- `server/index.ts` 与 `server/bootstrap.ts` 是进程组装根，允许导入所有层；除这两个文件外，`core` 不得导入 `crud`/`services`/`http`。
- `http → crud` 只允许**按路由文件登记的文件级闭集白名单**（见下节）；白名单同时覆盖运行时导入、`import type`、错误类/判定函数与聚合投影。白名单之外一律走 `services`；不得用“这个很简单”作为例外理由。
- 导出声明构成的公开契约类型必须可命名：导出函数（含导出常量中的函数）、导出接口、类型别名、类与变量单例的公开签名/成员/推断类型引用本文件定义的类型时必须导出该类型，禁止用私有类型构成公开契约；由 `server/__tests__/architecture/exported-signatures.test.ts` 强制。
- 需要组合多个 `crud` 调用、维护跨聚合不变量或发布事件的，必须由 `services` 提供用例，路由只调用 service。
- `crud` 可以在同一事务内调用其它 `crud` 的事务内辅助函数（如 `deleteAssetItemsTx`、账本函数）；不得调用会自行开事务或访问外部系统的 service。
- `services` 必须通过 `server/core/database/transaction.ts` 提供的 `withTransaction`（本期新增）开启事务并组合多个 `crud` 原语；事务内的单表 SQL 仍应下沉到 `crud`，避免同一写路径出现两份实现。

### 聚合与账本边界

- 业务聚合根：`canvasProject`、`asset`/`assetFolder`、`user`、`task`、`agentSession`/`agentMessage`、`provider`/`model`（模型配置聚合）。
- `file_ref` / `file_ref_count` 账本不是独立业务聚合，而是跨聚合共享的**事务内引用完整性原语**，由 `crud/file-ref-ledger` 提供。宿主聚合（资产、画布、用户头像）可以在自己的事务内写入账本，这不构成跨聚合编排；账本函数不得访问外部系统、发布事件或自行开事务。
- 聚合创建事务内允许对父级聚合做**只读**归属/存在性校验（如 `createSession` 校验 `canvasProject` 归属），但不得写入父级聚合。
- 跨聚合写入、租约/fencing、存储 key 归属与存在性校验、外部 I/O、队列投递、事件发布、提交后鉴权快照失效，必须由 `services` 编排；对应用例错误随用例移动到 `services`。
- `createProject`/`deleteProject` 只涉及宿主 `canvasProject` 聚合，保留 `crud`；`deleteProject` 在同一事务内回收引用账本，`createProject` 建立空画布、没有引用可登记。`updateProject`/`updateProjectDelta` 依赖编辑权租约与 fencing，上移 `services/canvas/project-write`。
- `updateUser` 需要存储 key 归属/存在性校验与提交后鉴权快照失效，上移 `services/user/update-profile`；头像账本本身仍是 `crud` 原语。

### `http → crud` 白名单（闭集）

白名单按「路由文件 → 允许符号」登记，不做模块级放行；同一 `crud` 模块在不同路由文件中未列出的符号仍属违规。

| 路由文件 | 允许导入的 `crud` 符号 | 归属与理由 |
| --- | --- | --- |
| `agent.ts` | `createSession`、`listSessions`、`getSession`、`renameSession`、`deleteSession`、`createMessage`、`listMessages`、`touchSession`、`PersistedToolCall`（类型） | Agent 会话/消息单聚合读写；`createSession` 同事务内只读校验项目归属 |
| `assets.ts` | `AssetOperationError`、`getFolders`、`createFolder`、`getFolder`、`updateFolder`、`deleteFolder`、`getAssets`、`getAsset`、`updateAsset`、`deleteAsset`、`deleteAssetsBatch`、`deleteAssetsByFileKeys`、`createAssetsBatch`、`updateAssetsBatch`、`listFileKeys`、`getAssetLibrarySummary` | 资产/目录单聚合读写与聚合内错误；账本为事务内引用完整性原语 |
| `auth.ts` | `getUserByUsername`、`getUserById`、`createUser`、`isUsernameTakenError`、`touchLastLogin`、`toPublicUser` | 用户单聚合读写、唯一键错误判定与聚合投影；`updateUser`/`UserAvatarKeyError` 与 `changePassword` 走 service |
| `canvas.ts` | `getProjects`、`createProject`、`getProject`、`deleteProject`、`projectExists` | 画布单聚合读/建/删；建删同事务仅写宿主聚合，删除回收引用账本、创建空画布不写账本；更新写走 service |
| `generate.ts` | `createTask`、`getTask`、`getTaskTerminalByIds`、`getProvider` | 任务/模型配置单聚合读写；终态编排、取消与终态投影走 service |
| `model-config.ts` | `getProviders`、`createProvider`、`getProvider`、`updateProvider`、`deleteProvider`、`addModel`、`batchSetModels`、`deleteModel`、`updateModelCapability` | `provider`/`model` 同一模型配置聚合成组读写 |
| `models.ts` | `getProvider` | 模型配置单聚合读 |

白名单规则：

1. 只允许单聚合读/写、聚合内错误类型/判定函数、聚合投影（如 `toPublicUser`）与持久化类型（如 `PersistedToolCall`）。
2. 白名单按「文件 + 符号」判定：同一符号在 A 路由允许，不代表 B 路由也允许；新增符号必须同时修改本节、架构测试与路由。
3. 禁止 `import * as crud from "@server/crud/<module>"`、默认导入与 `export ... from` 转发（无法静态确认实际使用符号）；禁止从 `@server/crud` 聚合根导入，必须指定具体模块。
4. 动态 `import()` 必须能静态解析说明符并按同一白名单校验；无法解析时 fail-closed，不得静默跳过。
5. `import type` 与运行时导入同规则；错误类、类型与判定函数不得作为绕过白名单的通道。
6. 白名单外新增依赖必须走 `services`；不得以“简单”“只读”“只是类型”为由扩大例外。

### 事务与 Unit of Work 约定

1. `server/core/database/transaction.ts` 提供 `withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>`；`DbTx` 是 `Prisma.TransactionClient` 的统一别名。禁止各模块自行定义同名类型或包装。
2. 事务内原语统一使用 `*Tx` 后缀（如 `updateUserFieldsTx`、`deleteAssetItemsTx`、`adjustFileRefCountTx`），第一个参数接收 `DbTx`；被传入 `DbTx` 的函数不得自行调用 `prisma.$transaction`。
3. 单聚合写由 `crud` 自己用 `withTransaction` 开启事务；跨聚合写由 `service` 用 `withTransaction` 组合多个 `*Tx` 原语。不得在 service 内直接写单表 SQL。
4. 禁止嵌套事务。service 已持有 `DbTx` 时，只能调用 `*Tx` 原语，不得调用会自行开事务的 crud 函数。
5. 事务内禁止外部 I/O、队列投递、事件发布、鉴权快照失效等副作用；这些动作在 `withTransaction` 成功返回（commit）后执行。`publishTaskTerminal`、`invalidateAuthSnapshot` 均属于提交后动作。
6. 迁移不改变现有事务隔离级别、超时与写集合顺序；若某条路径无法在保持事务边界的前提下上移，必须暂停并单独确认，不得用嵌套事务或拆事务绕过。
7. 现有 19 处 `$transaction` 按上述规则逐步统一；本期只要求迁移涉及的路径遵守，不要求顺带重写无关模块（`services/storage/gc.ts` 的终检事务不在本期改动范围）。

### 叶子模块规则

| 模块 | 允许依赖 | 禁止依赖 |
| --- | --- | --- |
| `server/utils` | `shared`、`server/schemas`（仅类型或纯值）、`server/core` 中的纯工具 | `crud`、`services`、`http`、数据库/事务/外部 I/O；`server/schemas` 不得反向依赖 `server/utils` |
| `server/schemas` | `shared`、`zod` | `crud`、`services`、`http` |
| `shared` | 无 server 依赖 | `server/**` |
| `server/core` | 按上方分层表 | `crud`、`services`、`http`（组装根除外） |

`import type` 与运行时导入适用同一规则；架构测试必须区分并检查类型-only 导入，不能把 `import type` 当作绕过边界的手段。

## 具体收敛方案

### 1. 文件引用账本下沉到 `crud`

- 将 `server/services/storage/file-ref-ledger.ts` 移动到 `server/crud/file-ref-ledger.ts`。
- 导出按事务原语约定更名为 `replaceSourceFileRefsTx`、`replaceSourceFileRefTx`、`removeSourceFileRefsTx`、`removeSourceFileRefsBatchTx`（`removeSourceFileRefsTx` 委托批量实现，不复制回收逻辑）；更新 `crud/asset.ts`（`replaceSourceFileRefTx`、`removeSourceFileRefsBatchTx`）、`crud/canvas.ts`（仅 `deleteProject` 的 `removeSourceFileRefsTx`；`createProject` 建立空画布，无引用可登记，不调用账本）、新建的 `services/canvas/project-write.ts`（内容写 `replaceSourceFileRefsTx`、封面 `replaceSourceFileRefTx`）、`services/user/update-profile.ts`（`replaceSourceFileRefTx`）及测试的导入；`crud/user.ts` 迁移后不再调用账本，不保留旧名转发。
- 理由：该模块只依赖 `@server/core/database/generated/client`、`@server/crud/file` 与 `@noxrea/shared/url`，不访问外部系统、不发布事件、不编排用例；它是事务内的引用完整性原语，应属于 `crud`。
- 迁移后 `crud` 内部对账本的调用变为 `crud → crud`，包级循环消失；`services` 继续可以导入它（`services → crud` 合法）。

### 2. 画布纯函数归位，写用例上移

- 将 `server/services/canvas/extract-hashes.ts` 的纯函数移动到 `server/utils/canvas-hashes.ts`。
- 将 `server/services/canvas/project-summary.ts` 的纯投影移动到 `server/utils/canvas-summary.ts`。
- 将 `updateProject`、`updateProjectDelta`、`leaseLostError` 以及 `CanvasRevisionConflictError`、`CanvasCoverKeyError`、`CanvasLeaseLostError` 移动到 `server/services/canvas/project-write.ts`。
- 将 `updateProjectDelta` 中的节点/边合并与 viewport/开关字段覆盖抽为纯函数 `applyCanvasDelta(base, delta)`，放在 `server/utils/canvas-delta.ts`；函数只做 JSON 结构合并，不读库、不派生摘要、不写账本。合并语义必须逐项保持现状：
  - 先以 `base.nodes` 中的 id 集合（删除前）与 id→upsert 映射计算：`nodes` = 基础节点过滤掉 `delta.nodes.delete` 后、对命中 id 用 upsert 节点替换，再追加“id 不在基础集合中”的 upsert 节点；`edges` 同理。同一 id 的 delete 与 upsert 同时出现时删除优先；upsert 中重复的新 id 会各追加一次，不额外去重。
  - `viewport` / `minimapVisible` / `snapEnabled` / `agentModel` 只在 `delta` 中对应字段 `!== undefined` 时覆盖（`agentModel: null` 是有效覆盖，不是缺省）。
  - 其余顶层字段从 `base` 原样保留（`{ ...base, nodes, edges }`），不重建未知字段。
- `updateProjectRow` 不整体上移，避免 `services` 直接写单表 SQL：拆为 `crud/canvas.ts` 的三个原语——`getProjectRowForWriteTx(tx: DbTx, id: string, userId: number): Promise<ProjectWriteRow | null>`（返回 `{ id, revision, canvasData（已解析对象）, coverKey }`，不得扩大投影）、`updateProjectRowTx(tx: DbTx, row: ProjectWriteRow, patch: ProjectWritePatch): Promise<ProjectRow | null>`（`ProjectWritePatch` 由 `crud/canvas.ts` 导出：`name?: string` / `canvasData?: Record<string, unknown>` / `coverKey?: string | null`；字段缺省表示不更新，`coverKey: null` 表示清空）（按 `row.id` 单条 `update` 写入；仅当 `patch.canvasData !== undefined` 时派生摘要并以数据库原子递增 `revision: { increment: 1 }` 写入（以数据库当前值为基准，不采用事务内读到的绝对值）；返回完整更新行 `ProjectRow`（`CanvasProject` 全列且 `canvasData` 已解析），保持 HTTP 响应形状；捕获 Prisma `P2025` 映射为 `null`，覆盖事务内行被并发删除的窄窗口）、只读非事务的 `getProjectRevision(id: string, userId: number): Promise<number | null>`（服务端原语，供 `leaseLostError` 在进入 `withTransaction` 前读取当前版本；与 web `entities/project` 的同步 selector 同名但位于不同层，两者语义各自以本层 Spec 为准）。`updateProjectRowTx` 不做版本冲突判定、不解析或校验 `coverKey`、不写账本、不抛业务错误，保证画布行写入只有一处；`row` 只能来自同一事务内的 `getProjectRowForWriteTx`，不接受任意外部构造的行。
- `project-write` 的内容写流程（请求携带 `canvasData` 或增量）固定为：`withProjectGate` 内租约校验 → `withTransaction` 内 `getProjectRowForWriteTx`（`null` → 返回 `null`，路由映射 404）→ revision 冲突判定（全量写与增量写统一：`row.revision !== baseRevision` 时抛 `CanvasRevisionConflictError`；路由与 service 入口均要求内容写必带 `baseRevision`，缺失即拒绝，不静默跳过判定）→（增量写）`applyCanvasDelta` →（`coverKey !== undefined && coverKey !== null`）`hashFromStorageKey` 严格解析，失败抛 `CanvasCoverKeyError`；`coverKey === null` 表示清空封面，跳过解析 → `updateProjectRowTx`（`null` → 返回 `null`，路由映射 404，跳过后续账本写入；全量写同时写入 `name`，增量写不写 `name`）→ `extractHashCountsFromCanvas` 新旧对比，仅当 `!hashCountsEqual` 时 `replaceSourceFileRefsTx`（布局保存零账本写入）→（`coverKey !== undefined`）封面账本 `replaceSourceFileRefTx`（`null` 清空）；service 内不出现 `tx.canvasProject.*`、JSON 合并实现或 `stringifyJson` 调用。
- `project-write` 的元数据（改名/封面）流程固定为：请求不含 `canvasData` 时不进门禁、独立 `withTransaction` → `getProjectRowForWriteTx`（`null` → 404）→（`coverKey !== undefined && coverKey !== null`）`hashFromStorageKey` 严格解析，失败抛 `CanvasCoverKeyError`；`coverKey === null` 表示清空封面，跳过解析 → `updateProjectRowTx`（`null` → 返回 `null`，路由映射 404，跳过封面账本写入）→（`coverKey !== undefined`）封面账本 `replaceSourceFileRefTx(tx, { userId, sourceType: "canvas_cover", sourceId: id }, coverKey ?? null)`；纯改名（`coverKey === undefined`）不解析、不触碰封面账本；不改 revision、不写内容账本。同一请求同时携带内容与封面时整体按内容写路径处理，门禁、行更新、内容账本与封面账本在同一 `withTransaction` 内完成，保持现有原子性；`withTransaction` 内不得调用会自行开事务的旧 `crud` 函数。
- `server/crud/canvas.ts` 保留 `getProjects`、`getProject`、`createProject`、`projectExists`、`deleteProject`；除 `@server/core/database/client`、`@server/core/database/generated/client`、`@server/core/database/transaction` 与 `./json-column` 外，只从 `utils` 与 `crud/file-ref-ledger` 取依赖。
- `http/routes/canvas.ts`：创建/读/删除继续从 `crud/canvas` 取（均在白名单内）；更新写接口与错误类型改从 `services/canvas/project-write` 取。
- 理由：更新写路径需要编辑权租约、fencing 与项目写临界区，属于跨聚合/外部状态编排；摘要派生、增量合并与引用计数是纯函数，放在 `utils` 让 `crud` 与 `services` 共用而不形成反向依赖。`createProject`/`deleteProject` 只写宿主 `canvasProject` 聚合；删除在同一事务内回收引用账本，创建空画布无引用可登记、不写账本，二者都不依赖租约、事件、队列或外部 I/O，按「聚合与账本边界」保留在 `crud`，并列入路由白名单。
- 若后续创建/删除需要跨聚合编排（例如创建默认资产、投递队列、发布事件），必须整体上移到 `services/canvas/project-write`，不得在 `crud` 内增加外部依赖。
- 测试调整：`server/__tests__/crud/canvas.test.ts` 中更新写路径用例迁移到 `server/__tests__/services/canvas/project-write.test.ts`；纯函数测试迁移到 `server/__tests__/utils/canvas-{hashes,summary,delta}.test.ts`；读/创建/删除用例保留在 crud 测试，并覆盖删除的账本同事务回滚；创建空画布不写账本。

### 3. 用户更新用例上移

- 将 `updateUser` 与 `UserAvatarKeyError` 从 `server/crud/user.ts` 移动到 `server/services/user/update-profile.ts`。
- `crud/user.ts` 保留用户查询、创建、密码、登录时间与 `toPublicUser` 等单聚合操作；新增事务内原语 `updateUserFieldsTx(tx, id, fields)`，不暴露敏感字段白名单之外的能力。
- 头像对象存在性查询下沉为 `crud/file.ts` 的 `hasFileObjectTx(tx, userId, hash)`；`project-write`/`update-profile` 不得直接调用 `tx.fileObject.*` 或 `tx.canvasProject.*`。
- 账本原语统一更名为 `replaceSourceFileRefsTx`、`replaceSourceFileRefTx`、`removeSourceFileRefsTx`、`removeSourceFileRefsBatchTx`，第一个参数固定为 `DbTx`；迁移后所有调用方（含 `crud/asset`、`crud/canvas`、`services`）同步改名，不保留旧名转发。
- `services/user/update-profile.ts` 负责：字段白名单、`avatarKey` 账本整替、头像 key 校验链（`hashFromStorageKey` 严格解析，解析失败即 `UserAvatarKeyError` → `isKeyOwner` 纯判定归属 → `hasFileObjectTx` 校验文件对象存在）、提交后鉴权快照失效；任一校验失败都在写库前抛 `UserAvatarKeyError`，不得先写后验。
- `http/routes/auth.ts` 的 `updateUser` / `UserAvatarKeyError` 导入改到 `services/user/update-profile`；`UpdatableUserFields` 不经 service 转发（路由无该类型消费方，不留无调用方的兼容导出）；修改密码改走 `services/user/change-password` 的 `changePassword`；其余 `getUserByUsername`、`getUserById`、`createUser`、`isUsernameTakenError`、`touchLastLogin`、`toPublicUser` 仍直接调用 `crud/user`，并逐项列入白名单。
- **规则 3.1：changePassword 同事务与快照失效归属**：`services/user/change-password.ts` 负责密码修改编排——`crud/user.updateUserPasswordTx(tx, id, hashedPassword)` 只做单表写入（新哈希 + 原子递增 `tokenVersion`），不感知快照；service 在**同一事务**内先用 `updateUserTx` 写可选画像、再写密码；事务提交成功后失效鉴权快照，不在事务内执行（事务回滚时缓存已删会造成无谓回源，虽然正确）。旧密码校验与哈希由 HTTP 层完成，且校验必须先于任何写入。`crud/user` 不再导入 `invalidateAuthSnapshot`，`setUserPassword` 更名为 `updateUserPasswordTx`，不保留旧名转发。
- 理由：头像校验涉及存储 key 归属解析与文件对象存在性，提交后还要失效鉴权快照；这是跨聚合用例，不应由 `crud/user` 承担。
- 测试调整：`server/__tests__/crud/user-auth-snapshot.test.ts` 的失效接线用例迁移到 `server/__tests__/services/user/change-password.test.ts`（含画像+密码同事务、头像失败不落库、失败不失效）；`user-avatar-ledger.test.ts` 的 `updateUser` 账本用例迁移到 `server/__tests__/services/user/update-profile-ledger.test.ts`，保留原有断言与真实库条件。原两个 crud 测试文件已删除。

### 4. 任务终态用例上移

- 将 `transitionToTerminal`、`completeTask`、`failTask`、`safeTerminal`、`safeCompleteTask`、`safeFailTask`、`cancelTask`、`toTerminalState` 移动到 `server/services/tasks/terminal.ts` 与 `server/services/tasks/terminal-state.ts`；`isTerminalTaskStatus` 作为终态判断谓词与 `TASK_TERMINAL_STATUSES` 同置于 `shared`（server 与 web 共用同一实现）；`getTaskTerminalByIds` 是对账读取投影，保留在 `crud/task`。
- `crud/task.ts` 保留任务创建、认领、租约/心跳、轮询、对账候选查询与终态行读取原语；新增 `writeTaskTerminal(id: string, status: TerminalTaskStatus, data: { resultUrls?: string[]; resultText?: string; error?: string; errorCode?: string }, startedAt: Date | null): Promise<TaskTerminalFields | null>` 写库原语，只写库并返回终态行，不发布事件。
  - `data` 是业务字段而非数据库列：`resultUrls` 的 JSON 序列化（`stringifyJson`）由 crud 在写库前完成；`completedAt` / `updatedAt` 由 crud 统一设为同一时刻。
  - `TaskTerminalFields` 返回已反序列化的 `resultUrls: string[]` 与 `config: Record<string, unknown>`（复用 `TERMINAL_FIELDS_SELECT` + `deserializeTerminalRow`），service 直接用它构造事件 payload，不得二次 `parseJsonArray` / `parseJsonObject` / `stringifyJson`。
  - `startedAt` 为 `Date | null`（认领令牌）：completed/failed 必须与 `where.startedAt` 精确匹配；cancelled 分支忽略该字段，只匹配 `pending|processing`。
- `writeTaskTerminal` 契约（守卫规则与 `transitionToTerminal` 等价，原子性必须强于现状）：
  - 守卫规则不变：completed/failed 只更新 `status="processing"` 且 `startedAt` 匹配的行；cancelled 只更新 `pending|processing` 的行，不带 `startedAt` 过滤。
  - 写库与返回行必须是同一条语句：使用 `prisma.generationTask.update({ where: <id + 守卫字段的扩展 where>, data, select: TERMINAL_FIELDS_SELECT })`，捕获 Prisma `P2025` 映射为 `null`；或使用 `updateManyAndReturn` 且只接受长度为 1 的结果。两种写法都只产生一次数据库写。
  - 禁止 `updateMany` + 无条件 `findUnique` / `findFirst` 重读：守卫命中后行可能已被并发改写，重读结果不能冒充本次写入。现状的该窗口必须在本期关闭，不得以“行为等价”为由保留。
  - 返回 `null` 表示守卫未命中；调用方不得广播、不得重试覆盖。只有单语句返回行时才发布事件，payload 由本次返回行构造。
  - 不引入显式多语句事务；单语句本身就是原子边界。若当前 Prisma 适配器不支持扩展 where 的 `update` 或 `updateManyAndReturn`，必须暂停并报告，不得退化为两段式读写。
- `services/tasks/terminal.ts` 调用 `writeTaskTerminal`，成功后用 `publishTaskTerminal` 广播；`safe*` 变体、`cancelTask` 与 `toTerminalState` 留在 service。
- `safeTerminal` 的日志保持不变：守卫未命中记 `channel="task"`、`stage="skipped_terminal_write"`；写库异常记 `channel="task"`、`stage="terminal_write_failed"`。写库成功后事件监听器抛错记独立 `stage="terminal_broadcast_failed"`（`taskId` / `error` 字段），不得归入写库失败或反向改变已提交终态。不得因迁移改变级别、字段或重复记录。
- `TerminalTaskState` 的状态字面量从 `shared` 的 `TASK_TERMINAL_STATUSES` 派生（新增 `TerminalTaskStatus` 类型），不再由 `services/tasks/watcher` 定义；`crud/task` 不再导入 `watcher` 或 `event-bus`。
- `http/routes/generate.ts` 的 `cancelTask`、`toTerminalState` 改从 `services/tasks/terminal` 导入，`isTerminalTaskStatus` 从 `shared` 导入，`TerminalTaskState` 类型改从 `services/tasks/terminal-state` 导入；`createTask`、`getTask`、`getTaskTerminalByIds` 继续从 `crud/task` 导入并列入白名单。
- 同步更新 `services/tasks/watcher.ts`、`services/tasks/event-bus.ts`、`services/worker/{executor,download-results,handler,poll-attempt}.ts` 的终态函数与 `TerminalTaskState` 导入：全部改从 `services/tasks/terminal.ts` / `terminal-state.ts` 取，不再从 `crud/task` 或 `watcher` 取终态编排语义。
- 理由：终态写入的“写库 + 广播 + 异常兜底”是一个用例，不是数据访问；拆开后 `crud/task` 不再依赖事件总线，`watcher` 与路由都从 service 取得终态语义。
- 测试调整：终态写入/广播/兜底用例迁移到 `server/__tests__/services/tasks/terminal.test.ts`；`crud/task.test.ts` 保留认领、租约、心跳、对账等原语测试。

### 5. 启动组装根移动

- 将 `server/core/bootstrap.ts` 移动到 `server/bootstrap.ts`，更新 `server/index.ts` 的导入。
- 理由：`bootstrap` 是进程组装根，负责初始化队列、Worker、网关、存储、GC；它不属于 `core` 基础设施，不应让 `core` 依赖 `services`。
- 架构测试将 `server/index.ts` 与 `server/bootstrap.ts` 列为唯一允许跨层导入的组装文件；其余 `core` 文件不得导入 `crud`/`services`/`http`。

### 6. `AssetOperationError` 与 asset 域归属

- `AssetOperationError` 与 `deleteAssetItemsTx` 继续留在 `server/crud/asset.ts`。
- 定位：`crud/asset` 负责资产聚合的持久化与事务内不变量（目录归属、受保护目录、资产存在性、文件 key 合法性、账本清理、目录计数递减）；这些错误是聚合内不变量错误，由 `http/routes/assets.ts` 映射为 HTTP 错误。
- 本期不把资产写用例拆到 `services/assets`：消除账本反向依赖后，`crud/asset` 不再导入 `services`，其职责与 `crud` 定义一致。若未来资产操作需要调用存储后端、GC、外部媒体处理或多聚合编排，再将对应用例上移到 `services/assets`，并把错误类型随用例迁移；不得为拆分而拆分。

### 7. Agent / 模型配置 / 模型路由保留单聚合直连

- `http/routes/agent.ts`、`model-config.ts`、`models.ts` 继续直接调用 `crud/agent`、`crud/model-config`；这些是会话/消息与 provider/model 单聚合读写，不需要新增 service。
- `createSession` 在创建会话的同一事务内只读校验 `canvasProject` 归属，属于聚合创建的父级引用校验；若未来增加配额扣减、队列投递、事件发布或跨聚合写入，必须把整个用例上移到 `services/agent`，路由改为只调用 service。
- `batchSetModels` 的批量替换属于同一模型配置聚合成组写入，保留在 `crud`；不得因为“批量”二字拆成 service。
- 以上符号全部登记在白名单；架构测试对这三个路由文件同样逐个符号校验。

## 错误分类与 HTTP 映射

| 错误类 | 当前抛出层 | 迁移后归属 | HTTP 映射 | 约束 |
| --- | --- | --- | --- | --- |
| `AssetOperationError` | `crud/asset` | `crud/asset`（不变） | `routes/assets.ts`：`invalid_file_key` 400、`uncategorized_folder_protected` 403、`folder_not_found` 404、其余 `asset_not_found` 404；重复来源 409 `assets.duplicate_file_key` 由单条创建的空 items 分支直接返回，不属于本错误类 | 聚合内不变量；类名不变，code 不含 `duplicate_file_key` |
| `CanvasRevisionConflictError` | `crud/canvas` | `services/canvas/project-write` | 409 `canvas.project_revision_conflict`，携带 `revision` | 写用例错误；类名/映射不变 |
| `CanvasLeaseLostError` | `crud/canvas` | `services/canvas/project-write` | 409 `canvas.project_revision_conflict`，有 revision 时携带 | 同上；无 revision 时省略 ctx |
| `CanvasCoverKeyError` | `crud/canvas` | `services/canvas/project-write` | 422 `common.invalid_request` | 同上 |
| `UserAvatarKeyError` | `crud/user` | `services/user/update-profile` | 422 `common.invalid_request` | 同上 |
| `Generation*Error` / 存储错误 | `services` | 保持 `services` | 现有路由映射 | 本期不迁移 |

- 错误类随用例移动；类名、错误码、HTTP 状态与响应结构保持不变；禁止在 service 重新定义同名错误或包装成通用 `Error`。
- 路由测试与 mock 路径同步迁移；`server/__tests__/http/routes/{assets,canvas}.test.ts` 的断言不得削弱。
- 新增错误必须登记到本表，明确抛出层、迁移后归属与 HTTP 映射；未登记的跨层错误类型视为未完成。

## 迁移顺序与验证

1. **架构基线**：先加 `server/__tests__/architecture/layer-boundaries.test.ts`，按「路由文件 → 符号」记录当前 `http → crud` 白名单（覆盖 7 个路由文件，含错误类、类型与投影）与组装根允许项，确认故意违规（未登记符号、namespace 导入、类型导入绕过）时测试会失败；之后再逐步收紧。
2. **纯函数**：`extract-hashes` / `project-summary` → `server/utils`；更新 `crud/canvas` 与测试导入。
3. **账本**：`file-ref-ledger` → `server/crud`；更新 `crud/{asset,canvas}`、`services/canvas/project-write`、`services/user/update-profile` 与测试（`crud/user` 迁移后不再调用账本）。
4. **任务终态**：新增 `terminal-state.ts` / `terminal.ts` / `writeTaskTerminal`；迁移 worker、watcher、event-bus 与 generate 路由；补守卫、cancelled、safe 兜底与广播时序测试。
5. **用户更新**：`updateUser` → `services/user/update-profile`；新增 `updateUserFieldsTx`；迁移 avatar ledger、auth snapshot 测试与 auth 路由 mock。
6. **画布写用例**：`updateProject` / `updateProjectDelta` / 错误类 → `services/canvas/project-write`；增量合并抽到 `server/utils/canvas-delta.ts`，`crud/canvas` 新增 `getProjectRowForWriteTx` / `updateProjectRowTx` / `getProjectRevision`；`createProject` / `getProject(s)` / `projectExists` / `deleteProject` 保留在 `crud/canvas`；迁移 canvas 路由与测试；补 metadata-only 绕过 gate、revision conflict、cover key、增量合并纯函数，以及删除的账本同事务回滚用例；创建空画布断言不产生账本写入。
7. **启动组装根**：`bootstrap` → `server/bootstrap.ts`；检查 `package.json`、启动脚本、构建入口与测试导入。
8. **收紧规则**：删除架构测试中的临时允许项，启用完整边界规则，跑全量检查。

每一步都必须保持服务端测试绿；`tsc`、`lint`、`vitest` 等内存任务串行执行，禁止在同一工作树并行启动多个检查进程。

## 已知债务与可观测性

- `crud/asset` 约 787 行 / 20 个导出，本期只消除 `services` 依赖，不拆分资产聚合；作为后续 Spec 候选，不因本次分层收敛而视为已解决。
- `updateUser` 的提交后语义保持不变：仅当 `isActive` 出现在更新字段中时调用 `invalidateAuthSnapshot`；该调用失败会让请求失败，但用户行与账本已在事务中提交。头像/主题/语言变更不触发失效。
- 任务终态的日志 channel/stage/字段保持不变（`task` / `skipped_terminal_write` / `terminal_write_failed`），并新增经评审的广播失败阶段 `terminal_broadcast_failed`（仅监听器抛错、写库已成功）；除此之外不得新增未评审的阶段名，也不得重复记录。

## 业务规则

1. **行为等价**：迁移前后，HTTP 状态码、错误码、错误消息、事务边界、租约校验、账本计数、终态广播、SSE 事件与并发行为（含全量/增量内容写的 revision 冲突判定与 `revision` 原子递增）完全一致。
2. **单向依赖**：`crud` 不得导入 `services`/`http`；`services` 不得导入 `http`；`core` 不得导入 `crud`/`services`/`http`（组装根除外）。
3. **事务归属**：跨聚合事务由 `services` 编排；单聚合事务与事务内不变量留在 `crud`。同一事务内不得混用两套写路径。
4. **错误归属**：聚合内不变量错误留在 `crud`；跨聚合/外部 I/O 用例错误随用例移动到 `services`。错误类名与映射保持不变。
5. **事件归属**：事件发布只在 `services`；`crud` 只返回写入结果，不发布事件、不调用外部系统。
6. **纯函数归位**：不依赖数据库、事务、外部 I/O 的画布摘要/引用计数函数放在 `server/utils`，由 `crud` 与 `services` 共同导入，禁止复制实现。
7. **无兼容层**：迁移后删除旧文件、旧导入与旧 mock；禁止保留转发模块或双实现。
8. **组装根唯一**：`server/index.ts` 与 `server/bootstrap.ts` 是唯一允许跨层导入的进程组装文件；其它模块不得以“启动需要”为由绕过层级。
9. **事务上下文**：`services`/`crud` 通过 `withTransaction` 与 `DbTx` 组合事务内 `*Tx` 原语；禁止嵌套事务；`crud` 收到 `DbTx` 时不得自行开事务；事务内禁止外部 I/O、事件发布与提交后副作用。
10. **路由例外闭集**：`http → crud` 仅限架构测试维护的「路由文件 + 符号」白名单，并同时约束运行时导入、`import type`、错误类与投影；白名单外新增依赖必须走 `services`，不得以“简单”“只读”“只是类型”为由扩大例外。
11. **叶子模块**：`utils`/`schemas` 不得依赖 `crud`/`services`/`http`；`shared` 不得依赖 server；`import type` 同规则。
12. **错误登记**：错误类随用例移动，类名/错误码/HTTP 映射不变；新增错误必须登记到错误表并由架构/路由测试覆盖。
13. **可观测性**：迁移不得改变现有日志 channel/stage/字段、事件广播次数与提交后副作用语义；行为等价验收包含这些非 HTTP 契约。终态广播失败使用经评审的独立阶段 `terminal_broadcast_failed`，与写库失败分离。

## 技术影响

- 新增 `server/services/canvas/project-write.ts`、`server/services/user/update-profile.ts`、`server/services/tasks/terminal.ts`、`server/services/tasks/terminal-state.ts`、`server/utils/canvas-hashes.ts`、`server/utils/canvas-summary.ts`、`server/utils/canvas-delta.ts`、`server/bootstrap.ts`。
- 新增 `server/core/database/transaction.ts`，导出 `withTransaction` 与 `DbTx`；迁移涉及的 `crud` 原语按 `*Tx` 约定调整签名。`crud/canvas` 新增 `getProjectRowForWriteTx(tx, id, userId)`、`updateProjectRowTx(tx, row, patch): Promise<ProjectRow | null>`、`getProjectRevision(id, userId)`；`crud/user` 新增 `updateUserFieldsTx(tx, id, fields: UpdatableUserFields)`；`crud/file` 新增 `hasFileObjectTx(tx, userId, hash)`，并将 `adjustFileRefCount` 更名为 `adjustFileRefCountTx`；`crud/file-ref-ledger` 导出 `replaceSourceFileRefsTx` / `replaceSourceFileRefTx` / `removeSourceFileRefsTx` / `removeSourceFileRefsBatchTx`。
- 删除/迁移 `server/services/storage/file-ref-ledger.ts`、`server/services/canvas/extract-hashes.ts`、`server/services/canvas/project-summary.ts`、`server/core/bootstrap.ts` 的原位置实现。
- 修改 `crud/{asset,canvas,task,user}.ts`、`http/routes/{agent,assets,auth,canvas,generate,model-config,models}.ts`、`server/index.ts` 及相关测试；`agent`/`model-config`/`models` 路由只核对导入并登记白名单，不改变行为。
- 新增 `server/__tests__/architecture/layer-boundaries.test.ts`，扫描静态 `import`/`export ... from`/动态 `import()` 说明符，排除 `__tests__`、`generated` 与组装根；优先使用 TypeScript AST 或成熟边界工具（如 `dependency-cruiser` / `eslint-plugin-boundaries`），不要用正则。必须处理 `import type`、`export * from`、路径别名、Windows 路径与无法解析的说明符；无法解析时 fail-closed。`http → crud` 白名单按 `Record<routeFile, ReadonlySet<symbol>>` 显式维护；namespace/default 导入与 re-export 直接判违规，不尝试推断符号。
- 不新增运行时依赖；若引入边界检查工具，只作为 devDependency 并单独说明。不改变构建产物；不改变 Prisma schema 或迁移历史。
- 测试迁移后，原有测试数量不减少；新增架构测试、迁移用例定向测试与行为 characterization tests（lease bypass、revision conflict、cover key、avatar 回滚、terminal 守卫/广播时序）。
- `bootstrap` 移动后检查 `package.json`、启动脚本、构建入口与部署配置，确认没有硬编码 `server/core/bootstrap` 路径。

## 异常与边界

| 场景 | 行为 |
| --- | --- |
| 路由为了省一层直接调用 `crud` 的跨聚合写 | 禁止；必须由 service 提供用例 |
| `crud` 内需要发布事件/调用队列 | 说明该逻辑属于 service；上移用例，不在 crud 内加事件总线 |
| service 直接写单表 SQL | 禁止；事务内单表 SQL 下沉到 crud 原语，service 只组合 |
| 迁移后错误类从 crud 移到 service | 保持类名、错误码与 HTTP 映射不变；只改导入路径 |
| 迁移导致事务边界变化 | 视为回归；必须保持同一事务内的写入集合与顺序 |
| 旧文件被删除但测试仍 mock 旧路径 | 更新 mock 到新模块；不得为测试保留旧路径导出 |
| 架构测试扫描到动态 import | 一并检查；组装根显式豁免，其它模块违规即失败 |
| 架构测试遇到无法解析的说明符 | fail-closed，按违规处理；禁止静默跳过 |
| `bootstrap` 移动后循环依赖 | `server/index.ts` → `server/bootstrap.ts` → services；不得反向导入 entry |
| 真实库测试因环境跳过 | 保持 `describe.skipIf` 条件，不把跳过当作通过 |
| service 已持有 `DbTx` 又调用自行开事务的 crud 函数 | 禁止；只能调用 `*Tx` 原语，否则视为嵌套事务缺陷 |
| `writeTaskTerminal` 守卫未命中返回 `null` | 不广播、不重试、不伪造终态行；`safe*` 记 `skipped_terminal_write` |
| `writeTaskTerminal` 采用 `updateMany` + 无条件 `findUnique` / `findFirst` | 视为并发缺陷；改为单条可返回行语句，重读不得冒充本次写入 |
| `project-write` 内联节点/边合并，或直接访问 `tx.canvasProject.*` | 视为分层违规；合并走 `server/utils/canvas-delta.ts`，读写走 `getProjectRowForWriteTx` / `updateProjectRowTx` |
| `coverKey === undefined` 时解析或写封面账本 | 视为缺陷；纯改名不触碰封面；`coverKey === null` 只清空、不解析 |
| `updateProjectRowTx` 返回 `null` 后仍写内容或封面账本 | 视为缺陷；`null` 表示行已不存在，必须在账本写入前早退 |
| 内容写只对增量做 revision 冲突判定，或 `revision` 用事务内绝对值写入 | 视为并发回归；全量/增量统一判定，`revision` 必须 `{ increment: 1 }` |
| 账本迁移遗漏 `removeSourceFileRefsBatchTx` 或 `crud/asset` 仍导入旧名 | 视为未完成；四个 `*Tx` 原语同步改名，调用方与测试全部迁移 |
| 路由调用白名单外的 `crud` 写函数 | 架构测试失败；应新增或改走 service 用例 |
| 路由从已登记模块导入未登记符号 | 架构测试失败；白名单按「文件 + 符号」判定，不按模块放行 |
| 路由用 `import * as crud`、默认导入或 `export ... from` 转发 | 架构测试失败；无法静态确认使用符号，直接按违规处理 |
| 聚合创建事务内只读校验父级归属（如 `createSession` 查 `canvasProject`） | 允许；不得写入父级聚合，不得追加外部 I/O 或事件 |
| 在 `crud` 事务内写引用账本 | 允许；账本是事务内引用完整性原语，不是独立聚合 |
| `utils`/`schemas` 反向依赖 `crud`/`services` | 架构测试失败；纯函数只能依赖 `shared`/纯工具 |
| 迁移改变日志 channel/stage/字段或广播次数 | 视为行为回归；按现有契约恢复或在 Spec 中另行确认 |
| 迁移后的路由测试仍 mock 旧模块 | 测试会因模块不存在失败；必须迁移 mock 与断言，不得保留双路径 |
| 事务内执行存储/队列/快照失效 | 禁止；副作用移到 commit 之后，且失败语义与现状一致 |

## 验收标准

1. `server/crud/**` 中不存在 `@server/services` 或 `@server/http` 导入。
2. `server/services/**` 中不存在 `@server/http` 导入。
3. `server/core/**` 中不存在 `@server/crud`、`@server/services`、`@server/http` 导入；组装根 `server/index.ts` 与 `server/bootstrap.ts` 位于 `core` 之外，在架构扫描中显式豁免。
4. `file-ref-ledger` 位于 `server/crud/file-ref-ledger.ts`，所有导入已迁移，无兼容导出。
5. `crud/canvas` 不再导入 `editor-lease`、`extract-hashes`、`project-summary` 或任何 `services` 模块；更新写用例位于 `services/canvas/project-write.ts`，创建/读/删除与账本维护保留在 `crud/canvas`；增量合并位于 `server/utils/canvas-delta.ts`，`project-write` 只通过 `getProjectRowForWriteTx` / `updateProjectRowTx` / `getProjectRevision` 读写画布行。
6. `crud/user` 不再导入 `file-ref-ledger`、`ownership` 或 `invalidateAuthSnapshot`；`updateUser` 位于 `services/user/update-profile.ts`，`changePassword` 位于 `services/user/change-password.ts`。
7. `crud/task` 不再导入 `event-bus` 或 `watcher`；终态写库原语与事件编排分离，`crud/task` 只写库。
8. `AssetOperationError` 与 `deleteAssetItemsTx` 仍在 `crud/asset`，HTTP 映射与错误表一致；重复来源 409 由单条创建的空 items 分支直接返回，不属于该错误类；`crud/asset` 无 `services` 导入。
9. 新增架构测试通过，并能在故意添加违规导入时失败：至少覆盖「未登记符号」「`import type` 未登记」「namespace/default 导入」「无法解析的动态 `import()`」四类负例。`http → crud` 白名单为按路由文件 + 符号的显式闭集，覆盖全部 7 个引用 `crud` 的路由文件；白名单外调用会失败。
10. 现有服务端测试全部通过；迁移后的测试位于对应层目录，断言未削弱。
11. `npx tsc --noEmit`、`npm run lint`、`npx vitest run`（单 worker、串行）通过。
12. 无 API/DB/事件契约变化；无新增 `any`、`eslint-disable`、兼容导出或死代码。
13. `server/core/database/transaction.ts` 导出 `withTransaction` 与 `DbTx`；迁移涉及的 `*Tx` 原语统一接收 `DbTx`，被传入时不再自行开事务；无嵌套事务。
14. 事务内无外部 I/O、队列投递、事件发布或鉴权快照失效；`publishTaskTerminal` 与 `invalidateAuthSnapshot` 均在 commit 之后执行。
15. `writeTaskTerminal` 的守卫与 `null` 语义、事件 payload 来源与日志 stage 正确；实现只用一条可返回行语句（`update` + 扩展 where 的 `P2025` → `null`，或 `updateManyAndReturn` 长度 1），不存在 `updateMany` + 无条件重读；有守卫命中/未命中、cancelled、写库异常、广播时序，以及并发改写下方仍只广播本次写入行的测试覆盖。
16. 错误表完整：迁移后的错误类归属、错误码与 HTTP 映射与表中一致；路由测试覆盖每条映射；无未登记的新跨层错误。
17. 叶子模块规则由架构测试覆盖：`utils`/`schemas` 不依赖 `crud`/`services`/`http`，`shared` 不依赖 server，`import type` 同规则。
18. 迁移按“迁移顺序与验证”一节推进，每一步服务端测试保持绿；每一步单独可回滚，不出现中间态双实现或旧路径兼容导出。
19. 日志 channel/stage/字段、事件广播次数与提交后副作用语义无变化；`updateUser` 仅在 `isActive` 出现在更新字段时失效快照，且提交后失败语义与现状一致。
20. 白名单与实际导入逐项一致：7 个路由文件的实际 `crud` 导入集合等于「`http → crud` 白名单」表格；不存在未登记符号、未使用白名单项或模块级放行；`agent`/`assets`/`model-config`/`models` 未新增仅为转发的 service 包装。
21. 聚合边界可验证：`createSession` 在事务内只读校验项目归属，不写 `canvasProject`；`createProject` 只写项目行（空画布无引用，不写账本），`deleteProject` 的项目删除与账本回收在同一事务内且回滚一致；`crud` 内无外部 I/O、事件发布或队列投递。
22. `services/canvas/project-write.ts` 与 `services/user/update-profile.ts` 不直接调用 `tx.canvasProject.*`、`tx.user.*`、`tx.fileObject.*`；分别经 `getProjectRowForWriteTx`/`updateProjectRowTx`/`getProjectRevision` 与 `updateUserFieldsTx`/`hasFileObjectTx` 组合，事务内单表 SQL 全部留在 `crud`；`updateProjectRowTx(tx, row, patch)`（`patch` 类型为导出的 `ProjectWritePatch`）只接受同事务 `getProjectRowForWriteTx` 返回的行，按 `row.id` 单条写入、返回完整且 `canvasData` 已解析的更新行，`P2025` → `null`，不做 revision 冲突判定、不解析/校验 `coverKey`、不写账本、不抛业务错误；`applyCanvasDelta` 只存在于 `server/utils/canvas-delta.ts`，其节点/边合并、删除优先、重复新 id 追加与 `!== undefined` 覆盖语义由纯函数测试逐项锁定；全量/增量内容写在写行前统一判定 `row.revision !== baseRevision`，`revision` 由 `updateProjectRowTx` 以 `{ increment: 1 }` 原子递增，不使用事务内读到的绝对值。
23. 账本原语导出与调用方一致：`crud/file-ref-ledger.ts` 只导出 `replaceSourceFileRefsTx`、`replaceSourceFileRefTx`、`removeSourceFileRefsTx`、`removeSourceFileRefsBatchTx`；`crud/asset.ts` 的批量删除使用 `removeSourceFileRefsBatchTx`，`crud/canvas.ts` 只在 `deleteProject` 使用账本（`createProject` 空画布无引用，不写账本），`crud/user.ts` 迁移后不再导入账本，各调用方无旧名导入、无转发导出；`removeSourceFileRefsTx` 委托批量实现；`crud/file.ts` 的引用计数增减原语更名 `adjustFileRefCountTx` 并同步账本内部调用与直测。
24. 公开契约可命名：`server/**` 生产代码的导出函数（含导出常量中的函数）、导出接口、类型别名、类与变量单例，其公开签名/成员/推断类型不得引用未导出的本文件类型；架构测试覆盖函数、接口成员、类型别名、类公开成员、变量初始化器（`as`/`satisfies`、对象字面量、class 表达式、`new`、解构与推断返回）以及 `typeof`/限定名，并覆盖私有类型负例、导出类型正例与 `export { Type }` 具名导出。推断类型另以 TypeScript 声明发射为事实来源：编译整个项目生成 `.d.ts` 后用同一检查器复扫（负例覆盖推断返回与对象简写），纯源码 AST 无法推断的形状同样受约束。

## 已确认事项

2026-11-04 用户确认本 Spec 及以下全部事项（1–12）；原问句保留为决策记录。

1. **目标方向**：是否确认 `http → services → crud → core`，并允许 `http → crud` 仅用于简单单聚合读/写？推荐确认；这是本 Spec 的核心约束。
2. **账本归属**：是否确认把 `file-ref-ledger` 下沉到 `crud`，而不是把 `crud/asset`、`crud/canvas`、`crud/user` 的全部写用例上移到 `services`？推荐下沉；改动面更小，且账本本身是事务内数据完整性原语。
3. **`createProject` / `deleteProject` 归属**：是否确认二者保留在 `crud/canvas`，仅将依赖租约的 `updateProject`/`updateProjectDelta` 上移？推荐确认；二者只写宿主 `canvasProject` 聚合；删除在同一事务内回收引用账本，创建空画布无引用可登记，二者都不依赖租约、事件、队列或外部 I/O。若要求所有多表写都上移 service，则需同时上移 `crud/asset` 的批量写路径，范围显著扩大。
4. **组装根**：是否确认把 `bootstrap` 移到 `server/bootstrap.ts`，并在架构测试中只豁免 `server/index.ts` 与 `server/bootstrap.ts`？推荐确认；比在 `core` 内保留例外更清晰。
5. **命名**：是否保留 `crud` 目录名，不在本期改为 `repository`？推荐保留；改名会扩大 diff，且不解决依赖方向问题。
6. **事务工具**：是否确认在 `server/core/database/transaction.ts` 新增并统一使用 `withTransaction<T>(fn: (tx: DbTx) => Promise<T>)`、`DbTx = Prisma.TransactionClient` 与 `*Tx` 命名，禁止各模块自建包装或嵌套事务？推荐确认；这是让事务边界可检查的前提。
7. **路由白名单**：是否确认 `http → crud` 采用「路由文件 + 符号」的闭集白名单，按本 Spec 表格覆盖 `agent`、`assets`、`auth`、`canvas`、`generate`、`model-config`、`models` 七个路由文件（含错误类、类型、投影与单聚合读写），并由架构测试逐项校验？推荐确认。若认为其中某些写操作（如 `createUser`、`batchSetModels`、资产批处理）也应走 service，请在确认时逐项指出；白名单以最终清单为准，未列出即违规。
8. **边界检查工具**：是否确认用 TypeScript Compiler API 写架构测试（仓库已有 `typescript` devDependency，零新增依赖），而不是引入 `dependency-cruiser` 或扩展 `eslint-plugin-boundaries`？推荐前者；若后续规则复杂到需要专用工具，再单独评估。
9. **终态写库原子性**：是否确认 `writeTaskTerminal` 只用单条可返回行语句完成“守卫写入 + 返回同一行”——优先 `update` + 扩展 where（`P2025` → `null`），或 `updateManyAndReturn`（只接受长度 1）；禁止 `updateMany` + 无条件重读，也禁止降级为两段式读写，适配器不支持时暂停报告？推荐确认；这是关闭现有并发窗口的前提。
10. **叶子规则**：是否确认 `server/utils`、`server/schemas` 为纯叶子层，`shared` 不依赖 server，且 `import type` 同样受边界约束？推荐确认；否则类型导入会成为绕过边界的主要通道。
11. **行为等价范围**：是否确认本次验收除 HTTP/DB/事件契约外，还包含日志 channel/stage/字段、广播次数与提交后副作用失败语义？推荐确认；这些是现有调用方与排障依赖的非 HTTP 契约。
12. **聚合与账本边界**：是否确认 `file_ref` 账本不是独立业务聚合，而是事务内引用完整性原语；允许宿主聚合事务写账本，允许聚合创建事务内**只读**校验父级归属；跨聚合写、租约/存储归属校验、外部 I/O、队列与事件必须上移 `services`？推荐确认；这是 `createProject`/`deleteProject` 归属与白名单的共同前提。

## 当前状态

- 2026-11-04：完成服务端依赖盘点与目标分层起草；本 Spec 为待确认，尚未修改任何业务代码。
- 2026-11-04：根据成熟度与遗漏审查补充事务/Unit of Work 约定、`writeTaskTerminal` 契约、错误分类表、叶子模块规则、迁移顺序与可观测性要求；待确认事项增至十一项。
- 2026-11-04：根据审核修订：`http → crud` 白名单补全为 7 个路由文件，改为「文件 + 符号」判定并覆盖错误类/类型/投影；明确 `file_ref` 账本为事务内引用完整性原语、`createProject`/`deleteProject` 保留 `crud`；修正事务计数为 19；修正 `server/core` 验收表述；补充负例与聚合边界验收。待确认事项增至十二项。
- 2026-11-04 二次修订：按审核结论修正——`writeTaskTerminal` 改为单条可返回行语句（`update` + 扩展 where 的 `P2025` → `null`，或 `updateManyAndReturn`），删除两段式降级；账本改名补入 `removeSourceFileRefsBatchTx` 并明确 `crud/asset.ts` 调用点；补齐 `getProjectRowForWriteTx` / `updateProjectRowTx` / `getProjectRevision` / `updateUserFieldsTx` / `hasFileObjectTx` 签名；增量合并抽为 `server/utils/canvas-delta.ts` 的 `applyCanvasDelta`；`server/utils` 允许仅类型引用 `server/schemas`；新增验收 23 与异常行。
- 2026-11-04 三次修订：依据二次审核结论修正——`updateProjectRowTx` 改为接收同事务 `getProjectRowForWriteTx` 的行、按 `row.id` 单条写入并返回完整解析行（`P2025` → `null` 映射 404），补全 `updateProjectDelta` 与元数据/封面的固定流程（封面 key 由 service 严格解析，内容与封面同事务）；`applyCanvasDelta` 明确删除优先、重复新 id 追加、`!== undefined` 覆盖（含 `agentModel: null`）等现状语义；账本调用方收敛为 `crud/asset`、`crud/canvas`（仅创建/删除）、`services/canvas/project-write`、`services/user/update-profile`，`crud/user` 不再调用；头像校验链补全 `hashFromStorageKey` → `isKeyOwner` → `hasFileObjectTx`；`writeTaskTerminal` 明确业务字段入参、crud 内 JSON 序列化与时间戳、反序列化返回投影及 `ownership` 语义；`crud/file` 的 `adjustFileRefCount` 更名 `adjustFileRefCountTx`。同步更新验收 22、23。
- 2026-11-04 四次修订：依据审核结论修正——元数据流程仅在 `coverKey !== undefined` 时解析并写封面账本，`coverKey === null` 清空且不解析；`updateProjectRowTx` 返回 `null` 时在写封面账本前早退；全量/增量内容写统一做 revision 冲突判定；`revision` 改为 `{ increment: 1 }` 原子递增；内容账本明确 `!hashCountsEqual` 短路。
- 2026-11-04 用户确认本 Spec（含上述十二项事项）；确认范围为业务规则、接口契约与技术方案，不含数据库变更、生产部署、提交或推送授权；状态改为「已确认」。尚未开始实现，未执行测试。
- 2026-11-05 根因修复（工作区未提交）：补全密码修改的 service 边界——`crud/user.setUserPassword` 更名为 `updateUserPasswordTx(tx, id, hashedPassword)` 并移除提交后鉴权快照失效调用，新增 `services/user/change-password.ts` 组合「单表写入 → 失效鉴权快照」，`http/routes/auth.ts` 改为从 service 导入 `changePassword` 与 `UpdatableUserFields`；`http → crud` 白名单同步删除这些符号。新增路由测试覆盖旧密码校验、用户不存在、头像 422 与密码更新后重签会话。
- 2026-11-05 原子性修复（工作区未提交）：`changePassword(id, hashedPassword, profile)` 在单事务内复用 `updateUserTx` 写画像、再经 `updateUserPasswordTx` 写密码，任一失败整体回滚；`PUT /api/auth/me` 先校验旧密码、再计算新哈希，头像引用非法返回 422 且不产生任何写入，cookie 仅在提交后重读用户时重签。回归用例：`services/user/change-password.test.ts`（画像+密码同事务、失败不失效）、`http/routes/auth.test.ts`（头像失败不落库、失败不重签）。状态保持「已确认」，实现代码未提交。
- 2026-11-04 实施完成（工作区未提交）：按「迁移顺序与验证」完成全部 8 步——架构基线测试、纯函数下沉至 `server/utils/{canvas-hashes,canvas-summary,canvas-delta}.ts`、引用账本下沉至 `server/crud/file-ref-ledger.ts`、任务终态拆分至 `server/services/tasks/{terminal,terminal-state}.ts`、用户更新拆分至 `server/services/user/update-profile.ts`、画布写拆分至 `server/services/canvas/project-write.ts`、`server/core/bootstrap.ts` 移至 `server/bootstrap.ts`，并删除剩余迁移豁免。用户更新测试按「mock 与真实库不可共存于同一文件」拆为 `services/user/{update-profile,update-profile-ledger}.test.ts`，均位于 service 层测试目录，原断言与真实库条件保留。验证结果：`npx tsc --noEmit` 通过；`npm run lint` 0 error（仅 6 个既有 web `<img>` warning）；`npx vitest run --maxWorkers=1` 106 个测试文件、1251 个测试通过，3 个依赖真实 Redis/S3 的集成测试文件跳过。首次全量运行曾因此前 120s 超时用例遗留的 PostgreSQL 会话与 advisory lock 出现 3 个超时；清理测试库孤儿会话后单跑与全量重跑均通过（环境残留，非代码缺陷）。状态保持「已确认」：实现代码尚未提交（提交需用户确认），验收项待用户走查确认后方可改为「已实现」。
- 2026-11-07 死代码清理（工作区未提交）：`createProject` 不再以空 `Map` 调用 `replaceSourceFileRefsTx`——空画布没有文件引用，该调用只做一次空读、不产生账本行；原注释「账本行存在使后续保存的引用增删有行可依」不成立，`file_refs` 行由后续保存按 hash 按需 `upsert`。相关测试改为锁定「创建空画布不写账本」，验收 21/23 与账本调用方描述同步；另修正 `editor-lease` 中 `isCurrentLease` 的调用层注释，并为验收 9 的负例补充 default 导入覆盖。
- 2026-11-07 导出契约修复（工作区未提交）：`crud/canvas.ts` 导出 `ProjectWritePatch`，`services/canvas/project-write.ts` 的私有 helper 与 `updateProject` 参数统一复用，消除三处同形定义；新增「导出函数签名必须可命名」规则、验收 24 与 `server/__tests__/architecture/exported-signatures.test.ts`（含私有类型负例与导出类型正例）。此前「收回 `ProjectWritePatch` 导出」的决策反转为导出——隐藏参数类型名不缩小契约，只会迫使调用方重写形状；记录同步见 `specs/web-module-contracts.md`。
- 2026-11-07 导出契约规则扩展（工作区未提交）：规则从「导出函数」扩展为所有导出声明的公开契约——导出函数（含导出常量中的函数）、接口、类型别名、类与变量单例的公开签名/成员/推断类型引用本文件类型时必须导出。架构测试补齐接口成员、类型别名、类公开成员、变量初始化器（`as`/`satisfies`、对象字面量、class 表达式、`new`、本地调用、解构与推断返回）、`typeof`/限定名、namespace 与 `export =` 的检查及对应负例。扩展后修复：导出 `AuthSnapshotResult`/`FileAccessDelivery`/`FileAccessResult`/`PresignResult`/`DerivedResult`/`UnauthenticatedRead`/`PreparedRead`/`SettingDef`，导出 `ToolRegistry`（单例由推断得到类型，无需显式标注）；`DerivedTier` 统一由 `core/metrics` 提供（storage 删除本地副本），`AddressingStyle` 同样由 `core/metrics` 声明（observability 3.8 的标签集合位置），`services/storage` 反向引用，删除 utils 中间层。验证：`npm run typecheck`、`npm run lint`（0 error）通过；全量服务端测试 108 个文件通过、3 个真实依赖集成文件跳过（1281 passed / 14 skipped）。
- 2026-11-07 导出契约守卫补强（工作区未提交）：推断类型不再只靠源码 AST——以 TypeScript 声明发射为事实来源，构建全项目 Program 生成 `.d.ts` 后，用同一检查器复扫（仅在 0 文件发射或存在发射诊断时失败；不把 `emitSkipped` 误判为失败），并补「推断返回」「对象简写」负例夹具。`REPO_ROOT`/`EXCLUDED_DIRS`/`walk`/`toRepoPath` 抽到 `server/__tests__/helpers/repo-source.ts`，与分层守卫共用一份源码树工具。验证：架构测试 12 用例通过；`npm run typecheck`、`npm run lint`（0 error，6 个既有 web `<img>` warning）通过；全量服务端测试 108 个文件、1283 passed / 14 skipped。
- 2026-11-07 审查修复（工作区未提交）：分层守卫补齐组装根唯一性——除 `server/index.ts`/`server/bootstrap.ts` 自身外，任何模块导入组装根均判违规，负例新增「service 导入 bootstrap」与「组装根互导放行」；删除不可达的 `tests` 层与 `layerOf` 分支（共用 `walk` 已整体排除 `__tests__`，该分支永不命中）。验证：架构测试 7 用例通过；`npm run typecheck`、`npm run lint`（0 error）通过；全量服务端 108 文件 / 1283 passed / 14 skipped，全量 web 207 文件 / 1643 passed。
- 2026-11-08 审查修复（工作区未提交）：删除 `services/user/update-profile.ts` 中无调用方的 `UpdatableUserFields` 兼容再导出（`http/routes/auth.ts` 未消费该类型），「路由导入」表述同步为不经 service 转发；`services/tasks/terminal-state.ts` 删除 `TerminalTaskStatus` 中转再导出，`terminal.ts` 直接从 `@noxrea/shared` 导入；`services/tasks/manager.ts` 的 `SubmitAndWaitResult.status` 改用共享 `TerminalTaskStatus | "async"`，避免终态集合新增成员时公开响应类型不扩展。验证：typecheck / lint 通过；定向 8 文件 / 79 用例通过；server 全量 108 文件 / 1286 passed / 14 skipped；web 全量 207 文件 / 1644 passed。
- 2026-11-07 审查修复二（工作区未提交）：分层守卫由「禁止表」改为与本章分层表逐项一致的「允许集闭包」——未登记的目标层一律违规（新增负例覆盖 `crud → resources` 与未分类 `server/*.ts` 文件），`utils → core` 只允许纯工具子树（`database`/`redis`/`http-client` 直接判违规），`assembly`/`resources`/`other` 显式登记，删除旧 `FORBIDDEN_TARGETS` 与失效的 `isServerLayer`。`ProjectWriteRow` 增加不可导出的 unique symbol 品牌：只有 `getProjectRowForWriteTx` 的返回值能作为 `updateProjectRowTx` 入参，crud 测试改为经真实 getter 取行，外部构造的行在类型层即被拒绝。验证：架构测试 9 用例通过；`npm run typecheck`、`npm run lint`（0 error）通过；全量服务端 108 文件 / 1285 passed / 14 skipped，全量 web 207 文件 / 1643 passed。
- 2026-11-08 内容写守卫收敛（工作区未提交）：`services/canvas/project-write.ts` 中 `updateProject` / `updateProjectDelta` 重复的「租约 fencing → baseRevision fail-closed → 事务内读行 → revision 冲突判定」收敛为单一 `withContentWriteTx`，调用方只提供事务内写动作；公共选项命名为导出的 `CanvasWriteOptions`（导出函数的公开签名必须可命名，沿用 2026-11-07 导出契约规则）。验证：`project-write.test.ts` 19 用例、导出签名架构测试 5 用例通过；`npm run typecheck`、`npm run lint`（0 error）通过；全量服务端 108 文件 / 1285 passed / 14 skipped。
- 2026-11-08 规则编号与引用归属（仅文档）：`services/user/change-password.ts` 的编排条款编号为规则 3.1（changePassword 同事务与快照失效归属），明确失效在事务提交成功后执行、不在事务内；`specs/auth-request-verification.md` 规则 4.1 / 4.2 改为引用本条，不再复制正文。规则语义未变。状态保持「已确认」。
- 2026-11-09 六轮评审修复（仅文档）：`createProject` 的两处 `web-module-contracts.md` 引用补齐规则 1（项目写互斥与项目 API 拆分），符合 `AGENTS.md` 十二.3.4；规则语义未变。状态保持「已确认」。
- 2026-11-09 七轮评审修复（工作区未提交）：`isTerminalTaskStatus` 从 `services/tasks/terminal.ts` 移至 `shared`（与 `TASK_TERMINAL_STATUSES` / `TerminalTaskStatus` 同源），server 路由、worker 与 web SSE 监控共用同一谓词，删除 web 侧重复实现；`writeTaskTerminal` 与 `services/tasks/terminal.ts` 的 `ownership: { startedAt }` 单字段包装取消，直接接收 `startedAt: Date | null`，调用方与测试同步。规则 4 签名与验收 15 语义不变。验证：`npm run typecheck` 通过；`npm run lint` 0 error（6 个既有 web `<img>` warning）；server 全量 108 文件 / 1286 passed / 14 skipped；web 全量 210 文件 / 1670 passed。状态保持「已确认」，实现代码未提交。
- 2026-11-09 七轮评审修复补充（工作区未提交）：`FileRefSourceType` / `FileHashCounts` / `FileRefSource` 移至 `server/schemas/file-ref.ts`（文件引用值域契约层），`crud/file-ref-ledger.ts` 只保留验收 23 规定的四个事务原语导出，公开签名引用外部已导出类型，满足验收 23 与 24 的共同约束。验证：typecheck / lint / 全量 server 与 web 测试同上一行通过。状态保持「已确认」，实现代码未提交。
- 2026-11-09 删除顺序根因修复（工作区未提交，跨 Spec 记录）：`crud/canvas.deleteProject` 的写集合顺序由「先清账本、后删项目行」调整为「先删项目行并持锁、后清 `canvas` / `canvas_cover` 账本」，用于关闭并发保存写入孤儿 `file_refs` 的窗口；事务边界、隔离级别与超时不变，验收 21 的项目删除 + 账本同事务回滚仍成立。该调整属于迁移完成后的后续根因修复，不是本期迁移的写顺序变更；证据与回归测试见 [storage-reference-key-unification.md](storage-reference-key-unification.md) 当前状态 2026-11-09 条目与 `server/__tests__/crud/canvas.test.ts`。规则 6 的迁移约束语义不变。
- 2026-11-09 用户确认全部验收标准通过并指示将状态改为「已实现」；实现代码随本次提交入库。
- 2026-11-12 错误契约同步（实现提交 `96ee9c9c`）：`AssetOperationError` 的 code 集合移除 `duplicate_file_key`；该 409 改由单条创建路由对 CRUD 返回空 items 直接返回，批量创建由数据库 `ON CONFLICT` 裁决并按已存在跳过。错误分类表、验收 8 与「其它已确认事实」已同步；验证见 `asset-write-serialization.md` 验证记录。状态保持「已实现」；本次 Spec 文档更新已随 `4f3ebb17` 提交。

# Storage Reference Key Unification

状态：已实现（2026-10-17 实现完成、数据迁移双库执行完毕、经用户确认提交。下阶段见 [storage-s3-backend.md](storage-s3-backend.md)）

## 目标

数据库与画布数据中对托管文件的引用统一为**存储 key**（`{userId}/{hash[:2]}/{hash}{ext}`），URL 降级为纯派生物——只在 API 响应（DTO）与前端渲染时由 key 构造。消除「key / URL 双表示」债：元数据联表不再解析 URL 字符串、GC 引用账本直接读 key、URL 路由与分发模式和持久化数据彻底解耦。

对齐主流 blob + key 模式（Rails ActiveStorage 等）：DB 存 key，API 出 URL。

## 范围

- 引用列 key 化 + Prisma 迁移（含 DB 结构变更：列改名与唯一索引调整）。
- `shared/url.ts` 与前端渲染点改造（key → URL 派生）；新增 **key 格式判别 helper**（服务端与前端共用）。
- 服务端 file-ref 账本、GC、元数据联表改读 key，移除 URL 字符串解析。
- 存量数据迁移脚本（重写 canvasData JSON 与文本列）。
- API DTO 调整：返回完整 URL（由 key 派生）并新增 key 字段。

## 非目标

- 不改 `file_objects` 表（PK `(userId, hash)` 即 key 的构成要素）与 `file_refs` 账本（已存 hash）。
- 不改 `/api/files/{key}` 路由格式与分发模式（属 [storage-s3-backend.md](storage-s3-backend.md)）。
- 不动外部 `http(s)` URL 引用（[canvas-image-http-url-rendering.md](canvas-image-http-url-rendering.md) 契约原样保留）。

## 引用清单

实现前仍需全量盘点核对；已核实项如下：

| 位置 | 现状 | 目标 |
| --- | --- | --- |
| `asset_items.sourceUrl`（unique `(userId, scope, sourceUrl)`） | 完整 URL | 列改名 `file_key`，索引改 `(userId, scope, file_key)` |
| `canvas_projects.canvasData` 节点 `data.src` | 内嵌 URL（受管与外部 http(s) 共用单字段） | 单字段保留，值域变为 key 或外部 URL（见下方取舍） |
| `canvas_projects.coverUrl` / `thumbnailSrc` | URL | key |
| `generation_tasks.resultUrls` | 已存 key | 不动 |
| `generation_tasks.refImages / refAudios / refVideos` | URL 数组 | key 数组 |
| `agent_messages.ref_images` 等 | 含 hash 的值（2026-10-17 已核实：双库实库 0 行、客户端唯一调用方不传该字段、请求侧已收紧 fileRefSchema） | 统一 key |
| `file_refs.hash` | 已存 hash | 不动 |

前端 `withManagedFileWidth`（托管缩略参数派生）与 `isManagedFileUrl`（托管 URL 形态识别，用于下载参数判定）保留为渲染期工具；`toFileKey` 仅用于媒体 API（抽帧 / 截取 / 代理）从引用值取回 key。不存在「粘贴 `/api/files/` URL 转 key」的用户流程（2026-10-17 审查核实：原条款描述的能力并不存在，按非投机原则删除该条款）。

**节点字段取舍**：保留单字段 `data.src`（值域 = key 或外部 URL），不拆 `fileKey` 双字段——外部 URL 是前端必须长期支持的值域（[canvas-image-http-url-rendering.md](canvas-image-http-url-rendering.md)），union 本身不构成债；拆双字段的改造面（undo/redo 载荷、upload pipeline、SSE monitor、全部渲染点）高一个量级而收益相同。配套新增 **key 格式判别 helper**（`{userId}/{hash[:2]}/{hash}{ext}` 严格校验）：服务端画布保存收集引用与账本登记、前端渲染分流共用，替代对 `/api/files/` 前缀的字符串解析。

## 业务规则

1. **key 唯一形态**：`buildStorageKey` 输出，是 `file_objects (userId, hash, ext)` 的确定性函数；DB 不存 URL。
2. **URL 派生只有两处**：API DTO 构造（`buildFileUrl`）与前端渲染 helper（`shared/url.ts`）；DTO 同时携带 `key` 与 `url`。
3. **账本与联表以 key 为输入**：file-ref 登记、画布保存 diff、`mediaMetaMapFor` 联表、`by-source` 资产操作全部用 key（经 key 格式判别 helper 识别；外部 URL 不入账本，与现状语义一致）；删除服务端对 `/api/files/` 的字符串解析（`getManagedFilePathname` 仅作为 web 端 `isManagedFileUrl` 的实现保留，用于下载参数判定与缩略参数派生）。
4. **迁移脚本幂等可重跑**：仅重写值为 `MANAGED_FILE_PATH` 开头的引用（绝对 URL 属外部值域，即使路径恰好含 `/api/files/` 也不改写——数据迁移只重写应用自己写过的值），**转换时剥离 `?w=` / `?download` 等查询参数**（key 只含路径部分，档位参数属渲染期派生、不落存储）；canvasData 为应用自有 schema-less JSON 且节点类型持续演进，深度遍历按「值整体恰为托管 URL 严格形态」判定改写（非子串匹配、非字段枚举），纯文本内容恰为完整托管 URL 的极端情况会被改写（概率可忽略，备份表可回滚；2026-10-17 审查如实记录谓词）；外部 http(s) URL 属合法值域，原样保留不告警；「托管形但无法解析为合法 key」的值原样保留并输出告警清单；canvasData JSON 解析失败即中止（fail-closed，对齐 storage v2 迁移先例）；执行前备份受影响行，输出变更统计。
5. **迁移执行窗口**：单实例部署，停服务期间执行。

## 技术影响

- `prisma/schema.prisma`：`asset_items` 列改名 + 索引调整；无新表。
- `scripts/`：key 化迁移脚本（独立于 S3 对象搬迁脚本）。
- `shared/url.ts`、web 渲染点（AssetCard / VideoNode / ImageRefCard / CanvasExplorer / 生成面板等）、上传与生成响应 DTO（SSE 需补 key 字段）、服务端 routes（assets / canvas / generate）与 crud 层。
- 画布 undo/redo 载荷仅值变化、结构不变（[canvas-undo-redo-integrity.md](canvas-undo-redo-integrity.md) 语义不受影响）。
- 验收含源码断言：server / web 源码中不再存在「把 `/api/files/` URL 写入 DB」的路径（粘贴识别除外）。

## 异常与边界

- 迁移脚本运行前必须停止服务写入（单实例窗口执行）。
- 画布粘贴文本只创建文本节点，无 URL → key 转换入口；如未来引入粘贴能力，必须在写入侧完成 key 归一，禁止读取侧自愈兼容层（2026-10-17 审查修订：原「粘贴识别转 key」条款描述的能力不存在，删除）。
- `thumbnailSrc` 语义（已核实 schema 注释）：保存事务中取首个带 src 的 image-node 的 src 作列表摘要冗余列——key 化后同步存该节点的 key。
- 客户端不持久化文件引用载荷：撤销栈、knownAssetKeys 均为内存态（会话切换即弃），cookie 仅存用户档案且字段契约变更经 parseUserCookie 严格校验整体失效、由 /me 重取——不存在需要自愈的旧 URL 残留面。如未来引入持久化客户端载荷，必须在写入侧完成 key 归一，禁止读取侧自愈兼容层（2026-10-16 审查修订：原「读取时自愈」条款预设的持久化面不存在，建立自愈层属投机兼容）。
- 与 S3 阶段的关系：本 Spec 独立可交付可验收；S3 阶段在 key 化完成后实施可获得干净合同（redirect 分发 + DTO 派生）。

## 验收标准

- 迁移脚本在样例库上幂等重跑通过；外部 URL 不受影响；告警清单为空或逐条处置。
- 全链路走查：上传 → 建节点（存 key）→ 保存画布 → 联表元数据 → GC 账本 → 删除回收，全程无 URL 解析。
- 源码断言通过；typecheck / lint / test 串行通过。

## 待确认事项

无（方向已于 2026-10-16 确认，其余按最简方案；确认本 Spec 即全部生效）。

## 当前状态

已实现（2026-10-17 经用户明确确认提交；全链路人工走查未单独留痕，由用户以提交确认放行，如走查发现缺陷按缺陷流程处理）。迁移脚本 scripts/db/migrate-storage-keys.mts 已按一次性脚本规则删除（双库执行完毕，备份表 _key_migration_backup_* 留存双库可回滚）。

已落地：Prisma 列改名（asset_items.file_key / canvas_projects.cover_key / users.avatarKey→avatar 列不变）与迁移 `20261016090045_storage_reference_keys`；数据迁移脚本 `scripts/db/migrate-storage-keys.mts`（幂等、备份、告警清单，覆盖 canvasData / cover / thumbnailSrc / refImages / refAudios / refVideos / agent 引用 / asset sourceUrl / users.avatar）；`shared/url.ts` STORAGE_KEY_PATTERN 判别；服务端账本/联表/保存 diff 全量 key 化并移除 URL 字符串解析；DTO 双字段（key + 派生 url）；SSE 增加 resultKeys；前端全部渲染点改 `managedFileUrl` 渲染期派生；ReferenceItem.thumbnail 撤销（缩略图不落 Tiptap attrs）；错误码 `assets.duplicate_file_key`。

验证：typecheck（server+web）、lint:web（0 error，26 条既有 img 警告）、lint:server、test:server（664 过/15 skip）、web test（918 过）全部串行通过；源码断言测试 `server/__tests__/storage/storage-key-contract.test.ts`（schema 无 source_url/cover_url、旧字段名消灭、crud 层无托管 URL 字面量）通过。

未验收项：全链路人工走查待用户确认。数据迁移已于 2026-10-16 在 NAS PG（10.10.10.2:9832/noxrea）执行完成：DDL（20261016090045）+ 数据重写（asset 9 条、canvas JSON 值 575 处、generation_tasks 1220 列值、users 1 条），幂等重跑全 0 命中、告警清单为空；本地 PGlite 同样完成迁移（2026-10-17）：本地模式执行本脚本时经 ensureLocalMigrations 自动应用 DDL 20261016090045 后重写数据（asset 9 条、canvas JSON 值 575 处、generation_tasks 1220 列值、users 1 条），幂等重跑全 0 命中。

code-review 审查与修复轮（2026-10-16，按「根因修复、行业成熟方案、不向后兼容、不打补丁」处置）：
- 引用值 → 访问 URL 规则收敛为 shared `resolveFileUrl` 单点（规则 2 的「两处派生」收敛为「DTO 与前端渲染共用同一函数」）；web `managedFileUrl` 与服务端 crud DTO 构造均改为委托该函数。
- 下载 URL 构造收敛为 web `downloadManagedFile` 单点：6 处下载入口（VideoNode / AudioNode / ImageNode×2 / MediaPreviewOverlay / 资产下载）统一「派生 URL + ?download=true&filename=」逻辑，资产下载原先缺失的 filename 参数随之统一。
- 迁移脚本改写为规则 4 字面语义（仅识别相对形态、绝对 URL 不改写不告警）；并对 NAS PG 备份表核查确认宽匹配版未误改写过任何绝对 URL（备份 1148 行 0 命中），幂等重跑全 0 通过。
- Spec 修订两处：规则 4 补充「绝对 URL 属外部值域即使路径含托管路径也不改写」与外部 URL 不告警；异常边界中「客户端读取时自愈」条款删除（该条款预设的持久化面不存在，自愈层属投机兼容，改为写入侧归一规则）。
- 修复轮验证：typecheck / lint:web（0 error）/ lint:server / test:server（664 过）/ web test（918 过）串行通过；契约测试注释字面量误报以改写注释措辞解决（保持绊线测试的粗暴字面量断言不变）。

第二轮审查与修复（2026-10-16，入库值域校验统一 + 账本不变量补齐）：
- key 段结构知识单点化：`hashFromStorageKey` 移入 shared/url.ts（STORAGE_KEY_PATTERN 捕获组提取，消灭第二处手工切片）；extract-hashes 仅保留画布计数逻辑。
- 入库值域校验统一（规则 1/3 的强制落地）：shared 新增 `isFileRefValue`（key 严格形态或外部 http(s) URL；data:/blob: 不持久化不在值域）；资产 `fileKey`、批量删除 `fileKeys` 走 schema 层 refine 校验；`avatarKey` 收紧为 key 严格形态（头像只来自上传，无外部 URL 值域）；crud 创建层对出域值 fail-closed 抛 `assets.invalid_file_key`（替代静默跳过账本登记——原行为会让托管文件失去 GC 保护）。
- 迁移脚本资产段改为单事务（去重删行 + key 重写原子生效，崩溃重跑保持幂等），删行对齐 deleteAssetsBatch 语义：先清引用账本（removeSourceFileRefsBatch）、再删行、并递减目录直属计数。
- web `multiResultUrls` 更名 `multiResultKeys`（字段与注释值域订正，值域同 src）。
- 同类问题排查结论：generation_tasks.ref_* 请求 schema 仍为宽松 `z.string()`，因未核实生成引用是否含 data:/blob: 形态（上传中预览等），本轮不收口、单独报告待确认。
- 第二轮验证：typecheck、lint:server、lint:web（0 error）、test:server（668 过/15 skip）、web test（918 过）串行通过；迁移脚本实库（NAS PG）幂等重跑全 0。

第三轮审查与修复（2026-10-17，派生形态收敛 + 引用命名统一 + Spec 如实化）：
- web 派生收敛：新增 `fileRefUrl`（非空引用值 → 访问 URL），替换全部 14 处 `managedFileUrl(x) ?? x` 形态；`withManagedFileWidth` 改为派生一次再判定（消灭 isStorageKey 双查与 shared 单点约定的自违）。
- mention 缩略图规则单点化：`refThumbnailUrl`（视频 #t=0.1 定帧 / 图片 w=64），MentionChip 与 MentionDropdown 共用。
- 下载语义订正：`downloadManagedFile` 的 download/filename 参数仅对托管分发路由追加；外部 URL 与 data:/blob: 原样直链（外链追加 query 可能破坏签名参数，data: URI 的 ? 属于数据本身）。
- 引用命名统一：`PreviewItem.url → ref`、director `Shot.url → ref`（含 canvasData 持久化字段的迁移改名段）、Inspector `previewUrl → previewRef`（仅快照预览 state；相机 POV dataURL 预览不属引用值、不改）。avatarKey 相关注释与测试夹具订正为 key 形态。
- 账本不变量单点化：新增 `deleteAssetItemsTx`（清账本 → 删行 → 目录计数聚合递减），deleteAsset / deleteAssetsBatch / deleteAssetsByFileKeys 与迁移脚本四处共用。
- Spec 修订：删除「粘贴识别转 key」能力条款（能力不存在）；迁移谓词如实记录（深度遍历按值整体严格形态判定）；下载语义外延记录。
- 同类问题排查结论（沿用第二轮）：generation_tasks.ref_* 请求 schema 宽松问题维持「待确认后收口」。
- 第三轮验证：typecheck、lint:web（0 error）、lint:server、test:server（668 过/15 skip）、web test（918 过）串行通过。迁移脚本 shots 改名段已于 2026-10-17 停服窗口对 NAS PG 执行：实库仅 1 行画布含 directorState 且 shots 为空数组（0 改名属正确结果），访问路径与实库结构一致经只读检查证实，改名分支以合成数据验证（有 url 改名生效、空/已改名/非 director 节点幂等不命中），幂等重跑全 0。

第四轮审查与修复（2026-10-17，校验分层对齐 + 残余重复收编 + 注释如实化）：
- coverKey 入库值域校验上移 schema 层（`refine(isStorageKey)`，与第二轮 fileKey/avatarKey 同一原则）；crud 层 `hashFromStorageKey` fail-closed 保留为账本 hash 派生与纵深防御，新增 `server/__tests__/schemas/canvas.test.ts` 锁定。
- VideoRefCard 视频定帧缩略改走 `refThumbnailUrl` (第三轮「视频 0.1s 定帧」单点的漏网第三处)；ImageNode 旋转/翻转烘焙复用组件体已派生的 `mediaUrl`。
- 迁移脚本备份/扫描谓词 `LIKE` 常量改由 `MANAGED_FILE_PATH` 派生（托管路径知识单点；已执行双库不受影响——派生值与原字面量相同）。
- 注释与 Spec 如实化：prisma schema ref_* 注释「URL 数组」→「key 数组」；「粘贴识别」残余表述订正（`getManagedFilePathname` 现存用途 = web `isManagedFileUrl` 实现，用于下载参数判定与缩略参数派生）。
- 待确认项扩展：agent_messages ref_images 请求侧（`agent.ts`）与 generation_tasks.ref_* 同为宽松 `z.array(z.string())`，并入同一「值域确认后收口」待决项。
- 第四轮验证：typecheck（server+web）、lint:web、lint:server、test:server、web test 串行通过（结果见本轮收尾报告）。

第五轮审查与修复（2026-10-17，ref* 值域收口 + 审查处置）：
- 值域追查收口（第二轮/第四轮挂起项终结）：生成面板 ref*（task.ts）全部派生自上游媒体节点 data.src——上传成功写 key、外部 URL 为合法值域、blob: 预览存于节点 upload.previewUrl 不进 src、上传失败态 src 为空被 filter(Boolean) 丢弃、data: 无任何写入 src 的路径；agent streamAgent 唯一调用方不传 refImages。值域 = 存储 key 或外部 http(s) URL，与资产 fileKey 完全一致。
- 值域校验单点抽取：新增 `server/schemas/file-ref.ts`（fileRefSchema），asset.ts 本地定义移入；taskCreateSchema refImages/refAudios/refVideos 与 agent streamSchema.refImages 同步收紧为 `z.array(fileRefSchema)`（拒绝 data:/blob:/裸路径）；新增 `server/__tests__/schemas/task.test.ts`。
- download 参数拼接复用 `withQueryParams`（导出单点）：消灭手拼 `?/&` 逻辑（该形态遇 hash 片段会把参数落进 fragment）。
- 注释补漏：prisma schema refAudios/refVideos 注释「URL 数组」→「key 数组」（第四轮仅订正了 refImages）。
- 审查记录：迁移脚本 director 改名段备份时序核实（改名前有专项备份，key 重写段原始值在首次备份中，两级备份链完整）；crud deleteFolder 未复用 deleteAssetItemsTx 属可接受语义差异（目录删除按 readCounters 重算，无逐目录递减需求）；watcher resultUrls 字段名沿用为已定决策（result_urls 列名不动）。
- 第五轮验证：typecheck（server+web）、lint:server、lint:web、test:server（672 过/15 skip）、web test 串行通过。

第六轮审查与修复（2026-10-17，提交完整性 + 契约具名化）：
- 提交完整性修正：第五轮新增的 3 个文件（file-ref.ts / task.test.ts / canvas.test.ts）当时处于未跟踪状态，且二至六轮修改未入暂存集——已全部 git add（暂存 ≠ 提交，提交仍待用户确认），暂存集 106 文件与工作区一致。
- 引用清单 agent_messages 行核实结论回写（「形态待核实」消除）：双库实库 0 行、客户端唯一调用方不传 refImages、请求侧已收紧 fileRefSchema。
- deleteAssetItemsTx 入参契约具名化 AssetItemLedgerRef（四处内联形状升为具名共享契约）。
- MentionChip import 逗号空格订正。
- 其余审核判定不动（记录理由）：迁移脚本标量重写形状 ×3（一次性已执行脚本，抽取无收益）；资产访问 URL 的 DTO 预派生与前端派生本就同源于 resolveFileUrl 单点（S3 阶段改分发只动一处）；avatarKey 无 max(200) 不构成不对称（isStorageKey 锚定模式本身严格限长）。
- 第六轮验证：typecheck、lint:server、lint:web、test:server、web test 串行通过。

# File Ref Ledger Bulk Removal

状态：已确认

决策记录：

- 2026-10-10 用户确认方案 A（IN 分片 5000）与大规模回归随 CI 常跑。
- 2026-10-11 代码审查后用户确认：单来源移除并入批量实现（"移除来源引用"只保留一套实现）；Web 批量分片失败语义保持"遇失败即停、已完成分片保留"。
- 2026-10-11 用户确认本版范围扩展（单来源移除并入批量、Web 分片契约、重复 id 不重复递减的措辞）。

## 目标

消除大批量资产删除时引用回收的逐 hash 循环：实测 5 万资产文件夹删除因约 5 万次串行 Prisma 查询触发交互式事务 5 秒超时（P2028），整批回滚且确定性失败。将 `removeSourceFileRefsBatch` 内部改为集合运算 SQL 后，同规模实测 892ms（IN 分片变体）/ 558ms（子查询变体），事务总耗时 <1s。

## 范围

- 重写 `server/services/storage/file-ref-ledger.ts` 中 `removeSourceFileRefsBatch` 的内部实现。
- `removeSourceFileRefs`（单来源）改为以单元素来源列表委托 `removeSourceFileRefsBatch`，"移除来源引用"只有一套实现；`replaceSourceFileRefs` 不变（按期望集合差值调整，语义不同，仍使用 `adjustFileRefCount`）。
- 函数签名、调用方（`deleteFolder`、`deleteAssetsBatch`、画布删除）、对外接口契约全部不变。
- 同批落地的 Web 端批量删除/移动分片提交，以及服务端批量上限常量 `ASSET_BATCH_LIMIT`（原 `max(200)` 魔法数字），契约见下文"Web 批量提交分片契约"。
- 不改变数据库结构；不改变 `file_objects` / `file_refs` 表语义；不改变 GC 流程。

## 业务规则（账本既有语义，重构必须逐项保持）

- `file_refs` 是引用事实来源；`file_objects.ref_count` 是按账本聚合的缓存，两者必须同事务变更。
- 移除来源引用 = 按 hash 合并各来源的 `count` → 对 `file_objects.ref_count` 做等量递减 → 删除对应账本行。单来源与多来源走同一实现。
- `ref_count` 归零的行保留，不在此处物理删除文件（归零判断与清理由既有 GC 流程负责）。
- `file_objects` 聚合行缺失时跳过该 hash（与既有 P2025 吞掉语义一致），不阻塞整体。
- 不产生负计数：递减量来自账本实际存在的行，因此无需对结果夹紧。
- 引用账本模块保持与具体业务表（asset_items 等）解耦：只接受来源 id 列表，不感知业务表结构。

## 技术方案

- 将"逐 hash 循环 `adjustFileRefCount`"改写为聚合 `UPDATE ... FROM (SELECT hash, SUM(count) ... GROUP BY hash)` + `DELETE`，使用 Prisma `$executeRaw`（SQLite 3.33+ 支持 UPDATE...FROM，Prisma 内置引擎满足）。
- `IN` 列表按分片提交（每片 5000 个来源 id）；每片先 UPDATE 再 DELETE。同一 hash 的聚合递减按片累加；`sourceIds` 含重复 id 时，后一片已无账本行可匹配，不会重复递减（"全部 UPDATE 后再全部 DELETE"的顺序反而会对跨分片的重复 id 重复递减）。分片大小从 500 上调至 5000（实测 892ms vs 3817ms）；参数上限由 5 万来源回归测试（10 个分片）实际覆盖。
- 推荐方案 A（保持 `sourceIds` 签名 + IN 分片），不采用耦合 `asset_items` 表的子查询变体（实测 558ms，收益不足以抵消账本模块的解耦破坏）。

## Web 批量提交分片契约

- 服务端按 id 的批量删除/移动单批上限为 `ASSET_BATCH_LIMIT = 200`（`server/schemas/asset.ts`）；Web 端 `features/assets/api.ts` 持有同值常量，两端数值必须同步修改；超量请求由服务端 422 兜底。
- Web store 对超过上限的批量删除/移动，按上限顺序分片提交，每片是独立的服务端事务。
- 每个成功分片后立即：应用服务端返回的计数快照、失效资产视图（打开中的列表重拉）、同步本地已知来源 URL 集合。
- 失败语义：某分片失败即停止后续分片，已完成分片保留（不回滚），弹出失败通知，调用方得到 `{ ok: false, total }`（`total` 为最后一次成功的计数快照，尚无成功分片时为 `undefined`）。
- 批量创建的分片提交契约见 `specs/asset-batch-upload.md`。

## 异常与边界

- 空来源列表：直接返回（现状保留）。
- `file_objects` 行缺失：UPDATE...FROM 不匹配即跳过，无错误。
- 同一 hash 被多个来源引用：聚合合并后一次递减（现状一致）；跨分片的同一 hash 按片累加。
- 事务超时语义不变（仍受 Prisma 5s 默认限制）；集合运算后 10 万级文件预计 <2s，处于预算内。

## 验收标准

- 既有 `file-ref-ledger.test.ts` 中 `replaceSourceFileRefs` 的用例不改动即通过；该文件中的 mock 基建（`makeTx` 的 `$executeRaw`）保留给"空来源列表不触发 SQL"用例。
- 单来源与批量移除的语义测试均在真实 SQLite 库接缝（`$executeRaw` 无法在内存 mock 上验证）：混合存在与缺失的 `file_objects` 行、同一 hash 多来源合并、其他来源不受影响、空列表/空来源。
- 5 万来源大规模回归（随 CI 常跑）：以 Prisma 默认 5s 事务预算本身为断言（超时会抛 P2028），不再设独立的耗时断言，避免 CI 慢机抖动；同时断言 `ref_count` 无负值、无残留账本行。
- Web：超过 `ASSET_BATCH_LIMIT` 的批量删除/移动按上限分片，某分片失败时停止并保留已完成进度（既有 store 测试覆盖）。
- 全量 server/web 测试、typecheck、lint 通过。

## 待确认事项

（无——2026-10-11 用户已确认本版范围。）

## 当前状态

- 已实施：`removeSourceFileRefsBatch` 集合运算（每片 UPDATE + DELETE）、`removeSourceFileRefs` 委托批量实现；单来源/批量/跨分片/5 万规模回归均在真实 SQLite 上通过；Web 分片提交与 `ASSET_BATCH_LIMIT` 已随上一次提交落地。
- 2026-10-11 审查修复已通过 typecheck、lint、全量 server 测试。

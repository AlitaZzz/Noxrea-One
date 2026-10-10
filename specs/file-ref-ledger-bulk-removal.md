# File Ref Ledger Bulk Removal

状态：已确认

决策记录：2026-10-10 用户确认方案 A（IN 分片 5000）与大规模回归随 CI 常跑。

## 目标

消除大批量资产删除时引用回收的逐 hash 循环：实测 5 万资产文件夹删除因约 5 万次串行 Prisma 查询触发交互式事务 5 秒超时（P2028），整批回滚且确定性失败。将 `removeSourceFileRefsBatch` 内部改为集合运算 SQL 后，同规模实测 892ms（IN 分片变体）/ 558ms（子查询变体），事务总耗时 <1s。

## 范围

- 仅重写 `server/services/storage/file-ref-ledger.ts` 中 `removeSourceFileRefsBatch` 的内部实现。
- 函数签名、调用方（`deleteFolder`、`deleteAssetsBatch`）、对外接口契约全部不变。
- 不改变数据库结构；不改变 `file_objects` / `file_refs` 表语义；不改变 GC 流程。

## 业务规则（账本既有语义，重构必须逐项保持）

- `file_refs` 是引用事实来源；`file_objects.ref_count` 是按账本聚合的缓存，两者必须同事务变更。
- 移除来源引用 = 按 hash 合并各来源的 `count` → 对 `file_objects.ref_count` 做等量递减 → 删除对应账本行。
- `ref_count` 归零的行保留，不在此处物理删除文件（归零判断与清理由既有 GC 流程负责）。
- `file_objects` 聚合行缺失时跳过该 hash（与现行 P2025 吞掉语义一致），不阻塞整体。
- 不产生负计数：递减量来自账本实际存在的行。
- 引用账本模块保持与具体业务表（asset_items 等）解耦：只接受来源 id 列表，不感知业务表结构。

## 技术方案

- 将"逐 hash 循环 `adjustFileRefCount`"改写为聚合 `UPDATE ... FROM (SELECT hash, SUM(count) ... GROUP BY hash)` + 分片 `DELETE`，使用 Prisma `$executeRaw`（SQLite 3.33+ 支持 UPDATE...FROM，Prisma 内置引擎满足）。
- `IN` 列表仍按分片提交，规避 SQLite 绑定参数上限；分片大小从 500 上调至 5000（实测 892ms vs 3817ms，参数数远低于现代 SQLite 的 32766 上限）。
- 推荐方案 A（保持 `sourceIds` 签名 + IN 分片），不采用耦合 `asset_items` 表的子查询变体（实测 558ms，收益不足以抵消账本模块的解耦破坏）。

## 异常与边界

- 空来源列表：直接返回（现状保留）。
- `file_objects` 行缺失：UPDATE...FROM 不匹配即跳过，无错误。
- 同一 hash 被多个来源引用：聚合合并后一次递减（现状一致）。
- 事务超时语义不变（仍受 Prisma 5s 默认限制）；集合运算后 10 万级文件预计 <2s，处于预算内。

## 验收标准

- 既有 `file-ref-ledger.test.ts` 中除批量移除外的用例（replace/remove 单来源语义）不改动即通过；支撑性 mock 基建随接缝迁移调整（makeTx 补 `$executeRaw`、清理失去消费者的 `{ in }` 查询分支），用例断言本身未变。
- 批量移除的语义测试从 mock 接缝迁至真实 SQLite 库接缝（`$executeRaw` 无法在内存 mock 上验证，mock 接缝随本次重构消失）：混合存在与缺失的 `file_objects` 行、同一 hash 多来源合并、空列表。
- 新增 5 万来源的大规模回归（随 CI 常跑）：在 Prisma 默认 5s 事务预算内完成，`ref_count` 无负值、无残留账本行。
- 全量 server/web 测试、typecheck、lint 通过。

## 待确认事项

（无——2026-10-10 用户确认方案 A 与 CI 常跑；原两项决策已移入决策记录。）

## 当前状态

- 实测原型已完成并验证正确性（50,000 资产：ref_count 全部归零、无负值、零残留）。
- 生产代码未改动。

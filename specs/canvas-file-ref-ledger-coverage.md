# Canvas File Ref Ledger Coverage

状态：已实现（2026-11-06 用户明确指示按「方案 A」修复；2026-11-09 用户确认全部验收标准通过并指示改为「已实现」，实现与本文档随 a2f521c0 提交）

## 目标

画布保存链路的引用账本覆盖画布数据中全部「直接渲染或使用」的托管文件引用，避免多结果次级图、导演镜头等引用未登记 `file_refs`，在 `file_objects.ref_count` 归零、超过宽限期后被 GC 连同对象删除，而画布仍在展示或使用它们。

## 背景（缺陷）

2026-11-06 诊断：项目 `mtmhb567ab7gh1` 的图片节点把两张生成结果存于 `data.multiResultKeys`，`data.src` 仅指向其中一张。旧提取器只统计 `data.src`，另一张从未进入账本；`file_objects` 行在 48h 宽限期后被 `runStorageGc` 回收，对象同时删除。画布仍渲染该结果，缩略图请求因源对象不存在持续记录 `stage=resize_failed`（`The specified key does not exist.`）。导演节点 `directorState.shots[].ref` 与实体 `srcUrl` 存在同类漏计。

## 范围

- 画布内容保存（`updateProject` / `updateProjectDelta`）的引用提取与账本 diff。
- 画布数据 JSON 内的托管文件引用字段。
- 对应回归测试与字段清单文档。

## 非目标

- 不改变账本表结构、`ref_count` 聚合语义与 GC 流程。
- 不改变外部 http(s) URL 的合法值域；外部 URL 不计入账本。
- 不自动修复存量数据：存量账本回填、悬空引用与重复引用清理须用户单独确认后执行；本 Spec 记录的是用户已明确授权的执行结果（见「当前状态」）。
- 不覆盖画布以外的引用来源（资产 `fileKey`、封面 `coverKey`、任务 `ref*`、agent 引用维持既有实现）。

## 业务规则

1. **账本字段清单**（唯一实现：`server/utils/canvas-hashes.ts`；画布数据无 schema，按节点 `data` 中的字段存在性统计，不校验节点 `type`）：
   - `data.src`（图片 / 视频 / 音频主媒体引用）；
   - `data.multiResultKeys[]`（图片多结果的堆叠卡 / 展开网格逐张渲染）；
   - `data.directorState.shots[].ref`（导演镜头的缩略图与「落回画布」的来源）；
   - `data.directorState.entities[].srcUrl`（导演实体的角色模型 / 贴图地址，含 crowd `members` 嵌套）。
2. 计数粒度是节点：同一节点内同一 hash 只计一次（含 `multiResultKeys` 重复项、多个镜头引用同一文件），不同节点分别累加。
3. 仅统计严格存储 key（`shared/url.ts` `hashFromStorageKey`）；外部 URL、`blob:` / `data:`、裸路径不计入。
4. 明确排除的字段及理由：
   - `genSettings.refOrder` / `refAudioOrder` / `refVideoOrder`：仅排序偏好；参考存在性派生自连线，`mergeOrder` 过滤失效项，文件由上游节点 `src` 保护；
   - `upload.previewUrl`：blob/data 预览，不持久化托管 key；
   - 提示词中的「图片N / 音频N / 视频N」：纯文本令牌，渲染时按实时引用还原，不存 key；
   - `label` / `content` 等自由文本：不因内容形似 key 而计入（显式字段清单，不做深度字符串扫描）。
5. 保存 diff 语义不变：布局保存（引用集合与数量不变）不写账本。

## 技术影响

- `server/utils/canvas-hashes.ts`：节点引用收集扩展为显式字段清单 + 节点内去重；移除未校验的节点类型断言；导演实体 `members` 改用显式栈迭代（客户端 JSON 嵌套深度不受控，递归会耗尽调用栈）。
- `shared/object.ts`（`@noxrea/shared/object`）：通用对象守卫 `isRecord`，server 的 `canvas-hashes`、`json-column`、`context-builder` 与 web 的错误体 / 会话载荷校验共用。
- `server/crud/json-column.ts`：JSON 文本列解析边界增加顶层形状校验（对象列要求普通对象、数组列要求数组）；解析成功但形状不符的坏数据降级为空值并记录告警。`getProjectRowForWriteTx` 等调用方由此始终拿到声明类型，而非 `null` / 数组冒充对象。
- `server/__tests__/utils/canvas-hashes.test.ts`：新增多结果去重（含同 hash 不同 key 形态）、导演镜头 / 实体嵌套、深层 `members`（5 万层）不溢出、跨节点累加、排除字段与畸形结构回归。
- `server/__tests__/crud/json-column.test.ts`：新增对象 / 数组形状校验与非法 JSON 降级回归。
- `specs/storage-reference-key-unification.md`：引用清单增加本 Spec 指针（账本字段覆盖面的单一来源）。

## 异常与边界

- 已删除对象不可恢复；本次修复只防止后续误回收。
- 存量画布的 `multiResultKeys` / 导演引用不会因普通布局保存自动补登：保存 diff 的新旧计数都来自同一提取器，集合未变时判定相等、不写账本。需要一次性账本回填或内容变更触发；回填属数据修复，须用户单独确认后执行。
- 提取器按字段清单读取，不递归扫描任意字符串；未来新增持久化引用字段时必须同步更新清单、测试与本 Spec，否则同类漏计会复现。
- 画布数据是客户端 JSON、无 schema：解析边界只保证顶层是普通对象（`canvas_data` 为 `null` / 数组 / 标量时按坏数据降级为空画布，引用计数为 0）；节点内部结构由提取器逐层守卫，畸形结构不抛错、不计入。
- 导演实体 `members` 使用显式栈迭代，嵌套深度只受内存限制；引用计数仍在节点内按 hash 去重收敛。

## 验收标准

- `extractHashCountsFromCanvas` 对上述四类字段按节点去重计数；外部 URL / 非法值 / 排除字段不计入。
- 回归测试覆盖多结果去重（含同 hash 不同 key 形态）、导演镜头与实体嵌套、深层 `members` 嵌套、跨节点累加、排除字段负例、畸形结构。
- JSON 文本列解析对形状不符的坏数据降级为声明类型（对象列 → `{}`，数组列 → `[]`），不向下游抛出 `null`。
- typecheck、lint、server 测试串行通过。
- 画布保存链路（`project-write` 单测）行为不变。

## 待确认事项

- 无。2026-11-06 用户已明确指示执行存量回填、悬空引用清理与重复项清理，执行结果见「当前状态」。

## 当前状态

实现与检查完成，已随 a2f521c0 提交；2026-11-09 用户确认全部验收标准通过，状态更新为「已实现」。2026-11-06 用户先后明确指示「执行回填」「清理引用」「清理重复项」，据此执行以下存量修复（一次性脚本，均未入库）：

- 账本回填（只增不减）：11 个项目、674 个期望引用中 673 个已由既有账本覆盖且计数一致，0 条需补登；唯一缺口是项目 `mtmhb567ab7gh1` 中已被 GC 删除的 `65e7…`，对象不可恢复。回填前后 `file_objects.ref_count` 与 `file_refs` 聚合不一致行数均为 0。
- 悬空引用清理：节点 `i-W8n2fRw5RfEbT` 的 `multiResultKeys` 移除 2 条 `65e7…`，revision 7777 → 7778，nodeCount 131 不变，账本按保存链路同一实现重算；复核本画布与全部 11 个画布残留引用均为 0。
- 重复项清理：同一节点 `multiResultKeys` 保留 1 条（与 `data.src` 同为 `14d18a02…`），移除重复 1 条，revision 7778 → 7779；账本期望按节点去重不变，复核账本与画布一致、聚合不一致行数 0。

说明（推断，未逐项目审计）：回填显示 673/674 个期望引用已由既有账本覆盖，唯一缺口是已删除对象。开发库由运行修改后代码的 dev server 服务，修复后的画布内容保存已用新提取器重算账本，可解释该结果。重复项清理后该节点 `multiResultKeys` 长度为 1；前端多图模式判定为 `length >= 2`，节点回退单图展示，主图 `data.src` 未变，属预期行为。

第二轮走查后按用户「根因修问题」要求补充修复（2026-11-06）：`json-column` 解析边界增加顶层形状校验（消除 `parseJsonObject` 返回 `null` 却声明为对象的不一致）；导演实体 `members` 改为显式栈迭代（消除深层嵌套栈溢出）；新增深层嵌套、跨节点累加与 JSON 列形状校验回归测试。

检查（2026-11-06，串行执行）：定向测试 16/16 通过；typecheck 通过；`lint:server` 通过；server 全量 107 个文件通过 / 3 跳过，1278 个测试通过 / 14 跳过。

2026-11-08 文档格式（已随 a2f521c0 提交）：业务规则 1 增加「账本字段清单」粗体标题，供其他 Spec 按 `AGENTS.md` 十二.3.4 精确引用；规则内容未变。

2026-11-09 验收确认：状态更新为「已实现」。实现代码（`server/utils/canvas-hashes.ts`、`server/services/canvas/project-write.ts` 及 `canvas-hashes` / `json-column` / `project-write` 回归测试）与本文档均随 `a2f521c0` 提交；验收标准全部为自动化项，无待人工走查项。评审修复后全量 server 测试 111 个文件（108 通过 / 3 跳过）、1295 个用例（1281 通过 / 14 跳过），退出码 0（此后无 server 运行时改动）；本 Spec 定向测试 16/16、typecheck、`lint:server` 均通过。

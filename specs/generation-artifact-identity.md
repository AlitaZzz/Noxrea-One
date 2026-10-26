# Generation Artifact Identity（生成产物身份与去重）

状态：已实现

决策记录：2026-10-27 起草（草稿）；同日用户确认本 Spec 与五项待确认事项（按推荐项定稿，见「已确认决策」）。确认仅覆盖业务规则、接口契约与技术方案，不等同于授权提交、推送或部署。

## 目标

为「一次生成任务的产物」定义本地可判定的唯一身份，把上游响应中的候选地址收敛为**以身份为键的有序结果集合**：消除 `resultUrls` 中的重复条目、重复解码与重复落盘，并为「上游形状不可假设」的候选发现提供正确性兜底。前端不再承担任何去重责任。

## 背景（调查结论）

上游响应无契约：各渠道返回形态各异，现有实现以「整树扫描 URL + 裸 base64 字段兜底」提取候选（`shared.ts` 的 `scanUrls` / `extractB64Fields`）。这条链路把三件不同的事混成了一件：

| 概念 | 现状 | 应定义 |
| --- | --- | --- |
| 上游给的一个字符串（URL / data URL / 裸 base64） | 被当作产物 | 候选，可信度低、形状不定 |
| 产物身份 | 该字符串本身 | 内容哈希（本地算出，与上游无关） |
| 产物集合 | `string[]` 按候选顺序追加 | 以身份为键的有序集合 |

具体现状（已验证；下列行号与行为均为**改造前**的位置，2026-10-27 已按本 Spec 实施，改造后的实现位置见「当前状态」）：

1. **仅有字符串级剪枝**：`scanUrls`（`server/services/protocols/openai/shared.ts:80-92`）在同一响应内以 `urls.includes(u)` 去掉完全相同的 URL 字符串；但这只是剪枝，不是身份判定。
2. **base64 侧完全不去重**：`extractB64Fields`（`same:98-106`）逐字段追加，`parseScanSyncResult`（`same:109-113`）与 `parseScanPollResult`（`same:119-139`）无条件拼接 → `{b64_json: X, b64: X}` 或数组中两处同一 b64 会产生两条相同 data URL 候选。
3. **结果集合无键**：`downloadResultsWithHeartbeat`（`server/services/worker/download-results.ts:24-49`）按候选顺序逐条 `downloadAndSave` 并 `push(key)`；同一个字节能以相同 key 重复入列。
4. **物理文件本就合并**：key = `{userId}/{hash[:2]}/{hash}{ext}`（`server/services/storage/service.ts:133-140`），`hash = SHA256(bytes)`、`ext` 由 `sniffMime` 按固定签名表首次命中（`download.ts:150-155`），即**同用户同字节必得同 key**；`persistFileObject` 按 hash 去重写 `file_objects`。所以重复只体现为「结果集合里的重复条目」与「重复解码 / 重复 put / 重复 DB upsert」，不占额外存储。
5. **候选发现存在实测缺陷**：`scanUrls` 的正则 `/(?:https?:\/\/|data:)[^\s"',;}\]<>]+/g`（`shared.ts:82`）把 `;` `,` 排除在字符类外，`data:image/png;base64,AAAA` 被截断为 `data:image/png`。后果：① `url` / 文本字段中的完整 data URL 永远丢失；② 截断垃圾会让 `parseScanPollResult` 判 `completed`（`shared.ts:136` 只看 `urls.length > 0`），随后全部解码失败 → `generation.download_failed`；③ 每个 data URL 多一次无效尝试与一条 warn。现有单测把该行为固化为期望（`server/__tests__/services/protocols/openai/shared.test.ts` 相关用例），已随本次实现订正。
6. **既有 Spec 都没有产物身份定义**：`specs/task-queue-bullmq.md:141` 只承诺「finalize 并发重复为幂等内容寻址写入 + 终态守卫」（写入幂等，不是结果集合语义）；`specs/storage-reference-key-unification.md:34` 只约定 `resultUrls` 存 key。本次修的是缺失的那一层。

**根因**：系统里没有「产物身份」，于是等价性只在「表示完全相同」时成立——不同签名 URL 指向同一字节、`data:` 与裸 `b64_json` 同字节、同一图出现在两个不同字段，全部漏掉。用表示当键，上游形状一变就失效。

## 范围

- 改动：
  - `server/services/protocols/openai/shared.ts`——候选发现按完整表示提取（`http(s)://` 与 `data:` 分别提取，不再依赖一套字符类），同步影响 `openai` / `ark` 两个协议的 image / video 解析；`shared.test.ts` 中固化截断行为的期望订正。
  - `server/services/storage/download.ts`——把 `downloadAndSave` 拆为「取字节」与「哈希 + 嗅探 + 落盘」两段（两条入口共用），使本地可判定的候选只需解码一次。
  - `server/services/worker/download-results.ts`——候选预筛 + 身份收口（有序集合）。
  - 相关单测；`specs/task-queue-bullmq.md:141` 的幂等表述改为引用本 Spec。
- 不改动：存储 key 规则与按用户命名空间隔离（`file-access-ownership.md`）；`resultUrls` 列名与「存 key」的约定（`storage-reference-key-unification.md`）；前端 `use-sse-task-monitor` 的消费逻辑（本 Spec 要求前端零责任）；不引入感知哈希 / 近似去重；不做 HEAD / ETag 跨 URL 预判。

## 业务规则

1. **产物身份**：产物身份 = `(userId, SHA256(bytes))`；存储 key 是该身份的唯一编码（key 额外携带由字节嗅探得到的扩展名，对同一字节确定）。身份在本地生成，与上游 URL、字段名、JSON 形状无关。
2. **候选 ≠ 产物**：协议层只产出候选列表，允许重复、允许误捕，**不承担去重正确性**。字符串级剪枝保留，但在代码与 Spec 中明确它只是廉价剪枝，防止后续在解析层叠加特判。
3. **候选发现按完整表示提取**：`http(s)://` 与 `data:` 使用各自的正则；data URL 必须取到完整载荷（`data:<mime>;base64,<payload>` 不被截断）；裸 base64 仍按字段名兜底（键名扩展属另一根因，见待确认事项）。
4. **身份收口（唯一）**：`downloadResultsWithHeartbeat` 是 `resultUrls` 的唯一写入点（同步提交 `executor.ts:154` 与轮询 `poll-attempt.ts:91` 共用 `finalizeGeneratedResult`）。结果集合以 key 为键、按**首现顺序**输出；同一身份重复出现只保留一条。
5. **预筛（成本优化，非正确性）**：
   - L0：同一原串只发起一次取字节（`Set`），零网络成本；剪枝只针对**已完成**（已落盘或已按身份合并）的候选——取字节 / 落盘失败的候选不登记，后续同串候选仍可重试（在尝试前登记会把一次失败固化成不可重试）；
   - L1：仅本地可判定的候选（data URL）解码后按字节哈希预筛，且落盘侧接收已解码 buffer，保证每个 data 候选只解码一次；
   - 预筛不承诺去重正确性，正确性只来自规则 4。
6. **落盘与对齐**：同一身份在一个任务内至多落盘一次；`resultSizes` 与 `resultUrls` 逐位对齐的关系由集合唯一性自然成立（`generate.ts:34` 无需改动）。
7. **幂等**：重复 finalize / 重复 tick / 断线重连全部收敛到同一集合；`startedAt` 终态守卫语义不变。`task-queue-bullmq.md:141` 的「finalize 并发重复」改为引用本 Spec 规则 4–7，避免两处口径。
8. **失败语义**：候选全部被合并后仍为空、或全部候选下载失败 → 仍判 `generation.download_failed`（现语义）；部分失败保留成功身份集合；候选为空（上游只给文本）→ 走既有文本终态路径。

## 技术影响

- `resultUrls` 的存储格式不变（`string[]`，值为 key），仅保证唯一；`generation_tasks` 无结构变更、无迁移。
- 协议层改动对 `openai` / `ark` 的 image / video 四条解析路径同时生效；`tasks/failure.ts` 的证据规则（先失败证据、后产物扫描）不变。
- `downloadAndSave` 拆为三段（取字节 / 身份 / 落盘），对外行为不变（`taskId` 日志、SSRF、重试、尺寸上限、超时全部保留在「取字节」段）。
- 前端无改动：SSE 终态消费、多图节点渲染直接受益于唯一集合。
- 单测：新增身份收口与预筛用例；修正 `shared.test.ts` 中对 data URL 截断的期望。

## 异常与边界

- **跨 URL 同字节**：必须下载后才能判定，因此**每个不同 URL 至多下载一次、每个不同内容至多落盘一次，允许一次冗余下载**（内容身份的上界，不是缺陷）。不做 HEAD / ETag 猜测。
- **上游确实返回两张同字节图**：按内容即身份合并为一条，丢失「上游表达了两个输出位」这一信息（待确认事项 1）。
- **顺序**：不承诺语义顺序，只承诺稳定（结算遍历顺序 + 首现）。上游 JSON 不保证顺序（待确认事项 2）。
- **裸 base64 键名依赖**：`b64_json` / `b64` 之外的键名仍会漏，本 Spec 不扩键名白名单；候选发现是否改为「内容签名验证」（长度阈值 + 解码前缀 + magic bytes，与键名无关）属独立根因（待确认事项 5）。
- **非 base64 的 data URL**（`data:text/plain,xxx`）：`decodeDataUrl` 返回 null → 候选丢弃（现语义，保留）。
- **混合拼接**：`data:…,https://…` 这种逗号拼接按两个候选提取（前瞻在 `data:` / `https?:` 处切分，base64 字母表不含 `:` 故不会误切合法载荷）；载荷里仍混有其它字母表外文本时，`decodeDataUrl` 按字符集整体拒绝该候选（不截断、不解成垃圾字节）。
- **载荷换行与边界歧义**：载荷中的空白（MIME 式换行）不是数据本身，解码前剔除，换行包裹的 `b64_json` 值可正常解码。扫描文本里的 data URL 若在空白处结束且空白之后仍是 base64 字符（与换行包裹形状相同、边界不可判），整条拒绝（fail-closed）——截断前缀会解码成损坏文件并被静默当成完整产物；空白后是非 base64 文本或另一个已知 scheme 时照常提取。
- **体积**：L1 预筛只处理本地 data URL，解码结果仍受 `upload.max_file_mb` 上限约束；远端下载的尺寸上限、超时、SSRF 校验不变。

## 验收标准

1. 同一响应内重复 URL → 结果一条。
2. `{b64_json: X, b64: X}`（或数组两处同 b64）→ 结果一条，且只解码 / 落盘一次。
3. `url` 字段中的完整 `data:image/png;base64,…` 被识别为候选（data URL 截断回归用例）。
4. data URL 前缀 label 与实际字节不符（如 `image/png` 实际是 jpeg）→ 按字节合并为同一身份。
5. 两个不同签名 URL 指向同一字节 → 只落一份、结果一条，位置取首现顺序。
6. 同一响应内多个不同内容 → 顺序稳定，与首现顺序一致。
7. 全部候选失败 → `generation.download_failed`；部分失败 → 保留成功集合的终态；纯文本结果路径不受影响。
8. 重复 finalize / 重复轮询 tick 写入同一集合，结果一致（幂等）。
9. `resultSizes.length === resultUrls.length` 在所有用例下成立。
10. server 全量测试、`typecheck`、`lint` 通过（高内存 Node 任务串行执行）；`shared.test.ts` 的截断期望订正后无遗留红。

## 已确认决策（2026-10-27，用户确认；原「待确认事项」五项，无剩余）

1. **同字节合并语义**：上游返回两张同字节图时合并为一条（内容即身份）；接受丢失「上游表达了两个输出位」这一信息。
2. **输出顺序**：采用首现顺序（结算遍历顺序），不承诺语义顺序。
3. **候选发现修复本次一并做**：`data:` 完整提取 + `http(s)` / `data:` 正则拆分，与身份收口同一批落地（只做收口的话，`url` 字段里的 data URL 仍会丢）。
4. **预筛范围**：L0 + L1 与 L2 一次做完。
5. **裸 base64 键名依赖**：另立 Spec 做「内容签名识别」候选发现，本 Spec 不扩键名白名单。

## 当前状态

已实现（2026-10-27）：全部验收标准通过（均为自动化核对，见「验收核对」，无人工走查项），实现提交 e86728da。此前同日起草并经用户确认（五项决策按推荐项定稿）。

实现记录（2026-10-27）：

- `server/services/protocols/openai/shared.ts`：候选提取改为单条交替正则（`http(s)` 与 `data:` 各自字符类）+ `normalizeCandidate` 收尾归一（data URL 只做语法形状判定：至少 `data:<meta>,<载荷>`；尾部只剔除字母表之外的标点，字母表含 base64url 的 `-` `_` 与解码端一致）；`(?!data:|https?:)` 负向前瞻在任何已知 scheme 前切分，逗号拼接的两个 data URL 不会被合成一条载荷，`data:…,https://…` 中的 URL 也不会被数据段吞掉；`truncatedPayloadTail` 拒绝「空白后仍是 base64 字符」的边界歧义候选（见「异常与边界 / 载荷换行与边界歧义」）。`openai` / `ark` 的 image / video 四条解析路径同时生效。
- `server/services/storage/download.ts`：`downloadAndSave` 拆为 `fetchMediaBytes`（data URL 本地解码 / SSRF 校验 + 下载，重试、尺寸上限、超时原样保留）、`identifyMediaBytes`（SHA256 + magic bytes → key）、`persistMediaBytes`（put + file_objects 登记）；旧聚合函数删除，唯一调用方同步迁移。data URL 分支补三道闸门：① 解码后按 `upload.max_file_mb` 限制体积（data 载荷不受 HTTP Content-Length 约束，缺此闸门会绕过上传上限直接落盘）；② `decodeDataUrl` 先剔除载荷空白（MIME 换行），再校验字符集（`Buffer.from(..., "base64")` 会静默丢弃非法字符，粘连的后续文本会被解成垃圾字节落盘）；③ 空载荷拒绝。
- `server/services/worker/download-results.ts`：候选原串 `Set`（L0，只在候选完成后登记）+ 身份 `Set`（L1/L2 合一，落盘前即判定）+ 首现顺序输出；同一身份只落盘一次；取字节 / 落盘失败既不登记原串也不写入身份集合（后续同串或同字节候选可重试/补写）；返回 `DownloadOutcome`（urls / candidates / attempted / merged），`download_failed` 与 `candidate_merged` 日志直接使用该计数，不用原始列表长度冒充预期数。
- 文档：`specs/task-queue-bullmq.md` 的 finalize 幂等条目改为引用本 Spec；`specs/file-access-ownership.md` 中已删除函数的引用同步更新。

复审修复（2026-10-27，用户指示「根因修复所有审查的问题」）：① data URL 解码补 `upload.max_file_mb` 体积闸门；② `decodeDataUrl` 载荷字符集校验（拒绝把粘连文本解成垃圾字节），字母表与提取端对齐（含 base64url）；③ 载荷空白（MIME 换行）剔除后再解码，空载荷拒绝；④ 扫描文本中「空白后仍是 base64 字符」的边界歧义候选整条拒绝（防止把换行截断的前缀当成完整产物静默落盘）；⑤ L0 只剪枝已完成候选，取字节 / 落盘失败的候选不登记，同串重复候选可重试；⑥ `download_failed` 计数改为下载阶段给出的 candidates / attempted / merged，不再用原始候选数冒充预期产物数。

验收核对（对照「验收标准」）：1–8 由单测覆盖（`shared.test.ts` 33 例、`finalize.test.ts` 13 例、`download.test.ts` 14 例，含 data URL 完整提取、逗号拼接不合并、data+https 混合拼接分别提取、换行截断边界拒绝、词中 `data:` 不算候选、重复候选只取一次字节、失败后同串候选重试、同字节不同表示合并且只落盘一次、前缀 label 不同按字节合并、首现顺序、落盘失败后可补写、全失败判 `download_failed`、data 载荷超限拒绝、非法字符载荷拒绝、MIME 换行载荷解码）；9 `resultSizes` 与 `resultUrls` 的对齐关系未改代码（集合唯一性使其自然成立）；10 server 全量 100 文件 / 1174 用例通过（14 例集成跳过）、`tsc --noEmit` 通过、改动文件 eslint 0 问题。尚未验证：真实上游样本中的重复频率与遍历顺序稳定性（属观察项，不影响契约）。

已验证事实（均核对当前代码）：

- `scanUrls` 仅做字符串级剪枝；`extractB64Fields` 不去重；两处解析无条件拼接。
- `downloadResultsWithHeartbeat` 是 `resultUrls` 的唯一写入点（`finalizeGeneratedResult` 仅被 `executor.ts:154` 与 `poll-attempt.ts:91` 调用）。
- key 由 `buildStorageKey` + `SHA256` + `sniffMime` 确定，同用户同字节必得同 key；`persistFileObject` 按 hash 去重写表。
- data URL 截断行为已由 Node 实测复现，且被现有单测固化为期望。
- 现有 Spec 中没有产物身份定义（`task-queue-bullmq.md:141`、`storage-reference-key-unification.md:34` 均只覆盖局部约定）。

未验证推测：

- 上游真实返回中出现重复候选 / 同字节多表示的频率（未抽样历史任务与 DB）。
- `walkResponseTree` 的遍历顺序在真实响应上是否稳定（理论成立，未抽样验证）。
- 非标准 b64 键名的真实案例（用户提出的场景，暂无样本）。
- 上游以换行包裹 data URL 载荷、或在同一文本字段里混排地址的实际频率（边界规则按 fail-closed 处理，均未抽样验证）。

# 派生删除联动补齐（Derived Deletion Linkage）

状态：已实现（2026-10-19，走查验收通过；实现提交 6e7ca8d0）
当前状态：全部验收标准 1–7 通过（含人工走查）；code-review 四轮收敛（第 4 轮两轴零需行动发现）；尚未推送。

2026-10-23 随画布 LOD 实现更新 `_cache` 键形态：增加版本段（当前 `_cache/v2/{tier}/{源键}.webp`），删除联动只枚举当前版本；无版本旧键不参与解析/枚举/联动，由一次性迁移删除（[canvas-media-resolution-lod.md](canvas-media-resolution-lod.md) 规则 8.3）。档位从 8 档扩为 12 档（上限 2560），`_cache` 精准 list 次数随之由 8 次变为 12 次。

## 已确认决策（2026-10-18，用户按推荐项逐条确认）

1. 枚举策略：**精准 shard list**（uniform 全前缀备选否决）。
2. TTL 触发点：**收敛到 GC 周期**（默认每日一次，周期由 `storage.gc_interval_seconds` 配置；路由顺带清扫迁走）。
3. TTL 值：**四根统一**（默认 30 天，由 `storage.derived_ttl_hours` 配置）。
4. 范围：**两类永久孤儿治理并入本 Spec**。
5. `_posters` 版本发现：**接口新增 `listCommonPrefixes` 能力**（全前缀备选否决）。

## 目标

补齐派生产物删除联动：源内容对象被删除时，其全部可枚举派生产物（`_cache`/`_posters`/`_sprite`/`_proxy` 四命名空间）同步回收，不再依赖 TTL 兜底。顺带治理调查中发现的两类永久孤儿派生对象（staging 源派生缓存、无 TTL 命名空间），使「派生物是可再生的缓存」这一不变量在全生命周期成立。

## 背景与现状（已验证事实）

- **删除联动的唯一源删除调用方是 GC**（[gc.ts](../server/services/storage/gc.ts) `backend.delete(item.key)`）：无任何 HTTP 路由直接删除内容对象（assets/canvas 删除走引用账本递减，存储回收统一由 GC 在宽限期后执行）。staging 删除（直传 complete 清理、`sweepStagingObjects` 24h 按龄清扫）只删 staging key。
- **backend.delete 契约**（specs/storage-s3-backend.md 规则 9「删除该 key 的一切」）：[local.ts](../server/services/storage/backends/local.ts) 与 [s3.ts](../server/services/storage/backends/s3.ts) 均经共享枚举器 `listDerivedArtifactKeys`（[backend.ts](../server/services/storage/backend.ts)）联动删除派生产物。当前枚举只覆盖 `_cache`/`_posters` 两根，按 `/${stem}.webp` 后缀匹配；`isStorageKey(key)` 门控使 staging / 派生 key 直接短路返回空（staging 清扫不为每个 key 付 list 流量）。
- **新形态已可枚举**：`_sprite/{源键stem}_c{count}v{N}.webp`、`_proxy/{源键stem}_w{width}v{N}.mp4`（[derived-keys.ts](../server/services/storage/derived-keys.ts) 构造/解析单点，specs/file-access-ownership.md 规则 7）。四个派生命名空间均在根段之后携带 `{userId}/{hash2}/` shard 段（`_cache` 在版本段与 tier 段后、`_posters` 在版本段后、`_sprite`/`_proxy` 紧随根）。
- **TTL 清扫现状**：仅 `_sprite/`（30 天，frame-sprite 路由顺带触发）与 `_proxy/`（30 天，video-proxy 路由顺带触发）有 TTL 清扫；**`_cache` 与 `_posters` 无任何 TTL**。由此存在两类永久孤儿：
  1. **staging 源的派生缓存**：会话路径 `?w=` 对 staging key 的缩放会产出 `_cache/v2/{tier}/staging/{userId}/{uuid}.webp`（specs/file-access-ownership.md 规则 3 认可的形态），海报档位派生同理可产出 `_posters/v{N}/staging/{userId}/{uuid}.webp`。staging key 被 `isStorageKey` 门控短路（无删除联动），staging 本体 24h 后被清扫，而这些派生条目既无联动也无 TTL——**永久孤儿**。backend.ts 现有注释称其「由 TTL 清扫兜底」与代码不符（失实注释，本 Spec 修正）。
  2. **版本升级孤儿**：`POSTER_VERSION` 升版后，旧版本 `_posters/v{旧N}/` 母版不再被任何路径命中且无 TTL——永久孤儿（低频事件：版本仅在代码变更时递增）。sprite/proxy 的版本孤儿已有 30 天 TTL 覆盖。
- **枚举成本现状**：每次内容键 delete = 2 次全前缀 list（`_cache/`、`_posters/`）；S3 ListObjectsV2 每页 1000 键。GC 单批上限默认 500 对象/轮（`storage.gc_batch_size`）。local 后端 list 按首段收窄遍历根，深层前缀进一步收窄。
- 缩放档位集合 `RESIZE_WIDTH_TIERS`（12 档）定义于 [shared/media-tiers.ts](../shared/media-tiers.ts) 并导出，前后端共用同一张表；derived-keys.ts 是四命名空间 key 格式知识单点（仅依赖 shared/url，无服务端内部依赖，可被 backend.ts 安全引用）。

## 范围

1. `listDerivedArtifactKeys` 枚举面扩展到四命名空间（`_sprite`/`_proxy` 新形态纳入删除联动），local 与 s3 两后端的 delete 语义同步收口（接口级共享实现，后端无需各自改动删除力学以外的部分）。
2. 枚举策略从全前缀 list 改造为按 shard 精准 list（待确认事项 1）。
3. `_cache`/`_posters` 补 TTL 清扫，消灭两类永久孤儿（待确认事项 2/3/4）。
4. backend.ts 失实注释修正；derived-keys.ts 枚举面与构造/解析同址扩展。

## 非目标

- 跨后端的派生删除联动（迁移脚本/审计的分类逻辑 `DERIVED_ROOT_PREFIXES` 不变，已含四根）。
- 旧单向哈希形态 `_sprite`/`_proxy` 存量对象的专项清理：不可枚举，维持 30 天 TTL 自然消亡，不做迁移。
- 引用账本/GC 语义变更：GC 调用方与回收条件不变。
- MinIO/R2 bucket lifecycle 规则替代代码清扫（部署侧可选项，代码保留兜底不变）。

## 业务规则（草案）

1. **删除联动覆盖四命名空间**：`delete(key)` 的派生联动枚举 `_cache`/`_posters`/`_sprite`/`_proxy` 四根——内容源 key 的派生产物按内嵌源键（stem）匹配：`_cache`/`_posters` 维持 `/{stem}.webp` 后缀，`_sprite` 为 `/{stem}_c\d+v\d+\.webp`、`_proxy` 为 `/{stem}_w\d+v\d+\.mp4`。匹配知识（候选前缀 + 后缀）与构造/解析同址于 derived-keys.ts，形成「构造 ↔ 解析 ↔ 枚举」三面单点。
2. **精准 shard 枚举**（推荐，待确认事项 1）：四命名空间的 key 均含 `{userId}/{hash2}/` shard 段，枚举按 shard 前缀精准 list，四根零全前缀扫描：
   - `_sprite/{userId}/{hash2}/`、`_proxy/{userId}/{hash2}/`：各一次精准 list（shard 段紧随根）；
   - `_cache/v{N}/{tier}/{userId}/{hash2}/`：版本段固定为当前 `RESIZE_CACHE_VERSION`（2026-10-23 起为 `v2`，见 [canvas-media-resolution-lod.md](canvas-media-resolution-lod.md) 规则 8.3），按 12 个缩放档位各一次精准 list（tier 集合为 cache key 的静态段域，`RESIZE_WIDTH_TIERS` 来自 `@noxrea/shared/media-tiers`）；
   - `_posters/v{N}/{userId}/{hash2}/`：版本段动态累积，先经一次 `listCommonPrefixes("_posters/")` 发现版本集，再逐版本精准 list。
   收益：单次 delete 的全部 list 均为 O(shard) 精准列举（约 0–20 键/次、页数 O(1)），与 S3 生态「prefix list + delete」标准做法同型；联动扩到 4 根的同时成本仍严格优于现状的 2 次全前缀 list，多用户公网规模不引入公网瓶颈（部署中立）。
3. **staging 源短路维持**：`isStorageKey` 门控不变——staging key 的 delete 不触发派生枚举（staging 清扫高频，不为每个 key 付 list）；staging 源的派生缓存由规则 4 的 TTL 兜底。旧单向哈希形态派生 key 传给 delete 时同样短路（只删本体，无递归枚举）。
4. **`_cache`/`_posters` TTL 兜底**（待确认事项 2/3）：四命名空间统一 TTL（`storage.derived_ttl_hours`，默认 720 小时 / 30 天），清扫挂接 GC 周期（`storage.gc_interval_seconds`，默认每日一次；runGcCycle 增加派生清扫阶段，与引用回收、staging 清扫并列独立成败；frame-sprite/video-proxy 路由内的顺带清扫迁入 GC，触发时机单一化）。受 `storage.gc_dry_run` 护栏约束（开启时只报告不删除，与 staging 清扫同一口径）。被老化的当前版本母版/档位缓存按需幂等重生成（ensureArtifact 语义不变）。同一 GC 周期另含探测残留清扫阶段（`_probe/`，见 [storage-provider-portability.md](storage-provider-portability.md) 规则 3.2），不属派生四根，与四根清扫互不影响。
5. **GC 调用方不变**：gc.ts 不感知派生枚举细节；backend.delete 契约「删除该 key 的一切」语义扩展为四根覆盖。

## 技术影响

- [derived-keys.ts](../server/services/storage/derived-keys.ts)：新增枚举面——`候选 shard 前缀构造（给定内容源 key）+ 四根后缀匹配器`，与既有构造/解析同址；`RESIZE_WIDTH_TIERS` 自 resize-cache.ts 迁入（cache key 段域知识，resize-cache 及其他引用方改改 import）。
- [backend.ts](../server/services/storage/backend.ts)：`listDerivedArtifactKeys` 改为按 derived-keys 候选前缀执行精准 list + 后缀匹配；接口新增可选 `listCommonPrefixes(prefix): Promise<string[]>`（S3 以 ListObjectsV2 Delimiter 实现，local 以 readdir 一层目录实现；唯一消费方为 `_posters` 版本段发现）；失实注释修正（staging 源派生缓存兜底方式改为指向本 Spec TTL 规则）。local 后端 readdir 枚举错误口径统一（list / listCommonPrefixes 共用 readdirOrEmpty）：目录缺失为合法空集，其余错误上抛，与 S3 fail-fast 同口径。
- [sweep.ts](../server/services/storage/sweep.ts)（新增）：按龄清扫共享力学单点——判龄（lastModifiedMs 缺失视为未到期）、gc_dry_run 只计不删、单条删除失败留痕续行；枚举失败上抛（阶段失败可见性归调用方），根间隔离粒度归策略侧。
- [derived-cleanup.ts](../server/services/storage/derived-cleanup.ts)：派生侧策略——四根清单 + 统一 TTL（`storage.derived_ttl_hours`，默认 720 小时）+ gc_dry_run 护栏；单根枚举失败留痕不中断其余根，全部根尝试后聚合上抛（阶段失败经 GcCycleResult.derivedSweepError / CLI 退出码可见）；被 GC 周期调用（新增阶段挂接 [gc.ts](../server/services/storage/gc.ts) runGcCycle，独立成败）。
- [probe-cleanup.ts](../server/services/storage/probe-cleanup.ts) / [gc.ts](../server/services/storage/gc.ts)：GC 周期的第四阶段清扫启动探测残留（`_probe/`，固定 24h，`PROBE_ROOT_PREFIX`），与派生清扫并列但对象域互不相交；结果字段 `probeSwept` / `probeSweepError`，`ok` / `partial` / `failed` 按四阶段聚合。
- [upload-direct.ts](../server/services/storage/upload-direct.ts)：staging 清扫（阈值 `storage.staging_max_age_hours`，默认 24h）改调共享力学核 sweepAgedPrefix；枚举失败由留痕改上抛，恢复「GC 记录 sweepError / CLI 退出码 1」语义。
- [frame-sprite.ts](../server/http/routes/frame-sprite.ts) / [video-proxy.ts](../server/http/routes/video-proxy.ts)：顺带清扫调用迁出（TTL 常量统一收口）。
- [resize-cache.ts](../server/services/storage/resize-cache.ts)：档位常量迁出后改从 derived-keys 引用。
- [scripts/storage/gc.mts](../scripts/storage/gc.mts)：CLI 输出与退出码纳入派生清扫阶段成败（derivedSwept / derivedSweepError）。
- [specs/storage-s3-backend.md](../specs/storage-s3-backend.md)：规则 9 改写——delete 联动四命名空间（精准 shard 枚举）+ 四根统一 TTL（`storage.derived_ttl_hours`）挂 GC 周期（`storage.gc_interval_seconds`），交叉引用本 Spec。
- 测试：derived-keys 枚举面往返锁定（构造函数产物必被「候选前缀 + 后缀」命中，覆盖四命名空间 × 内容源/staging 源矩阵；staging/派生 key 短路维持）；local 后端删除联动扩展（四根回收、旧形态不联动）；TTL 清扫 dry-run 报告语义；GC 周期新阶段成败隔离；TTL 清扫失败语义（单条失败续行、根枚举失败聚合上抛、_posters 旧版本母版回收直测）与 staging 清扫枚举失败上抛断言。

## 异常与边界

- 旧单向哈希形态存量：不可枚举、不联动，30 天 TTL 自然消亡；期间读路径 404 自愈（既有语义）。
- 精准 list 与对象不可见窗口：S3 list 最终一致（强一致桶不受影响）；联动漏删的对象由 TTL 兜底，不丢内容（派生皆可再生）。
- TTL 判龄基于 lastModifiedMs（0 视为未到期，同 staging 清扫口径），不误删在途产物。
- 清扫失败语义：单条删除失败留痕续行；枚举失败上抛（staging 单前缀直接上抛；派生四根逐根隔离，全部根尝试后聚合上抛），经 GcCycleResult.sweepError / derivedSweepError / probeSweepError 与 CLI 退出码对外可见，下一周期自然重试。根前缀目录缺失为合法空集，其余枚举错误不静默跳过。
- 当前版本母版被 TTL 老化：下次请求触发 ensureArtifact 重生成（每视频每 TTL 周期至多一次 ffmpeg，轻型池），代价可接受，不做「豁免当前版本」特判。
- GC 删除与派生读并发：派生枚举删除期间读请求最多得到一次 404 缓存未命中并触发重生成，无一致性风险。
- staging 源派生缓存的 TTL 窗口（最长 30 天）内对象无源可派生：源已清扫后这些缓存不可达（读路径源 404），删除无损。

## 验收标准

1. GC 回收内容源后，其 `_sprite`/`_proxy` 新形态派生产物同步删除（local 与 S3 语义一致，真库/真后端测试覆盖）。
2. delete 联动不触碰旧单向哈希形态与 staging/派生 key（短路语义有测试锁定）。
3. staging 源 `_cache`/`_posters` 派生条目在 TTL 内回收，无永久孤儿（清扫测试覆盖）。
4. `_posters` 旧版本母版在 TTL 内回收。
5. 单次内容键 delete 的后端 list 调用全部为精准 shard 前缀（_cache 8 桶 + _sprite + _proxy + _posters 版本发现后逐版本），零全前缀扫描（list 调用断言）。
6. `storage.gc_dry_run` 开启时派生清扫只报告不删除。
7. typecheck / lint / 全量测试串行通过；derived-keys 三面（构造/解析/枚举）往返锁定齐备。

## 派生治理行业对照（结论性记录）

本 Spec 的机制组合为行业通行做法，无自创机制：

| 机制 | 本 Spec | 行业对照 |
| --- | --- | --- |
| 源删除级联清理派生产物 | delete(key) 联动四命名空间 | Rails ActiveStorage 变体 purge、WordPress 附件中间尺寸删除、Cloudinary 派生清理——删除源资产时同步回收派生物是媒体系统通行做法 |
| 枚举实现 | 确定性段域静态展开（tier）+ 动态段一次发现（版本）+ shard 前缀精准 list | S3 生态删除前缀集合的标准做法即 ListObjectsV2(Prefix/Delimiter) + 逐键 Delete；Delimiter 子前缀列举是「文件夹遍历」惯用法 |
| 可再生缓存 TTL | 四根统一 30 天 sweeper | S3 Lifecycle / MinIO ILM 按前缀过期是派生缓存治理的行业标准；代码侧 sweeper 为部署中立替代（bucket 规则可替代，代码兜底保留） |
| staging 源派生不联动走 TTL | isStorageKey 门控维持 | 高频批清扫路径不为单 key 付 list 成本——批量删除设计普遍规避 per-key list 同理 |
| 派生 key 格式知识单点 | derived-keys 构造/解析/枚举三面同址 | 「派生命名可确定性重导出」是 ActiveStorage 变体、imgproxy/thumbor 签名 URL 方案的共同前提；三面同址为本仓单一实现原则的落实 |

## 待确认事项（2026-10-18 提请确认）

1. **枚举策略**：推荐精准 shard list（规则 2，成本严格优于现状、部署中立）；备选为 uniform 四根全前缀 list（实现最简，每次 delete 增加 2 次全前缀 list，多用户规模下成为公网瓶颈）。
2. **TTL 触发点**：推荐收敛到 GC 每日周期（四根统一、gc_dry_run 护栏、时机单一，路由顺带清扫迁走）；备选为维持路由顺带触发并新增 _cache/_posters 两处（改动最小，但触发点分散至 4 处、低流量期不清扫、无护栏）。
3. **TTL 值**：推荐四根统一 30 天（与 sprite/proxy 现值对齐，单一常量）；备选 _cache/_posters 更短（如 7 天，省空间但增加重生成频率）。
4. **范围**：推荐将两类永久孤儿治理（规则 4 + 失实注释修正）并入本 Spec（同一「派生生命周期」治理，拆分割裂）；备选仅做联动扩展（原始遗留项字面范围），孤儿治理另立 Spec。
5. **`_posters` 版本发现**：推荐接口新增 `listCommonPrefixes` 能力（一次前缀列举返回子前缀集，S3 Delimiter 惯用法）用于发现版本段，`_posters` 联动升级为逐版本精准 list——四根枚举策略统一、delete 路径零全前缀扫描；备选为保留 `_posters/` 全前缀 list（零接口扩展，但多用户规模下母版量随视频数线性增长后，成为 delete 路径最后的 O(n) 全扫描瓶颈）。

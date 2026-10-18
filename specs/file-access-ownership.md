# 文件读取归属校验（File Access Ownership）

状态：已实现（2026-10-18，用户走查验收通过；实现提交 01b160f6）
当前状态：实现完成并验收通过。经五轮 code-review 双轴审查闭环（第二轮修复：derived-keys 构造/解析同址单点、isKeyOwner 三调用点统一判定、shared 注释锚点归位、审计日志测试断言；第三至五轮双轴均零硬性违规、零 Spec 缺失——规则 1–7 与验收 1–10 逐条核验通过，审查循环收敛）——typecheck / lint / server 826 用例 / web 928 用例串行全过，dev 环境实测归属拒绝（404 与不存在响应不可区分，审计日志含 user+key），用户走查「播放/预览回归」通过；实现提交 01b160f6。

## 目标

关闭文件读取的跨用户越权（IDOR）：`/api/files/*` 的会话凭据当前只做认证（任意已登录用户可读任意对象），补充对象归属校验，使「登录」与「有权读该对象」同时成立。顺带闭合引用接受边界的幽灵聚合行问题（avatarKey 指向不存在对象时 `adjustFileRefCount` upsert 出的 GC 不可见惰性行），并把归属解析收敛为全仓单点实现。

## 背景与现状（已验证事实）

- [files.ts](../server/http/routes/files.ts) 双凭据放行：会话（任意登录用户）**或** key 绑定签名 URL；无对象归属比对。这是唯一缺失归属比对的读路由。
- [media-edit.ts](../server/http/routes/media-edit.ts) 路由工厂已自建归属防护 `keyBelongsTo`（首段 == userId）+ stat 存在性 404；但该规则仅理解内容键命名空间（派生/暂存/畸形键一律 403），且为工厂私有实现，与读路由不共享。
- download.ts 是服务函数（`downloadAndSave` 等，worker 内部调用），非 HTTP 路由，无缺口。
- key 全集四类命名空间：
  - 内容对象 `{userId}/{hash[:2]}/{hash}{ext}`（buildStorageKey，含 AI 生成结果）
  - 直传暂存 `staging/{userId}/{uuid}`（归属编码在 key；直传 ticket 已有归属形态检查）
  - 派生（内嵌源键，归属可解析）：`_cache/{tier}/{源键去扩展名}.webp`、`_posters/v{N}/{源键去扩展名}.webp`
  - 派生（单向哈希，归属不可解析）：`_sprite/{sha1(源键|格宽|帧数|版本).slice(0,32)}.webp`、`_proxy/{sha1(源键|宽|版本).slice(0,32)}.mp4`
- 防线现状：路径穿越守卫（403）、后端逃逸守卫（StorageTraversalError）、对象不存在 404。files 路由唯缺归属。
- 威胁面：hash 是 256 位不可猜，但同一 hash 双重充当「标识符」（API 响应、URL、DB 合法流转）与「唯一门禁」；userId 为顺序小整数，一次泄漏即按用户枚举放大。行业对 per-user 命名空间文件服务的标准做法是认证 + 归属强制（见下方业务规则依据）。

## 范围

1. `/api/files/*` 读路径（302 redirect / relay 流式 / Range / `w=` 缩放缓存全部分支，守卫置于分支汇合点前单点覆盖）。
2. media-edit 路由工厂的私有 `keyBelongsTo` 撤销，与读路由共用同一归属解析器（AGENTS 三.3 同一规则单一实现）。
3. 引用接受边界中的 avatarKey（updateUser）：补归属 + 存在性校验。
4. `_sprite`/`_proxy` key 形态改造为内嵌源键 + 参数段（与 `_cache`/`_posters` 统一），使派生 key 全集归属可解析。

## 非目标

- 跨用户共享/协作 ACL 体系（未来分享、社交展示功能届时另立 Spec，本 Spec 只留公开产物白名单的扩展点）。
- canvas 内容 src / canvas coverKey / asset fileKey 的引用侧存在性校验：读路径归属校验落地后，引用他人 key 的读回被 404 封死，自身命名空间伪造 hash 只剩惰性聚合行（GC 候选排除 + audit 清单可观察），危害不成立。avatarKey 例外原因：其 `adjustFileRefCount` 正 delta upsert 有真实副作用且已发生。
- 上游 AI 消费链路（worker 签名 URL 签发与校验）——凭据模型不变。
- admin 后台工具。
- 派生删除联动（listDerivedArtifactKeys）纳入 `_sprite`/`_proxy`：新形态后已可按源键枚举，属可选简化，本期不做（TTL 清扫兜底不变）。

## 已确认决策（2026-10-18，用户按推荐项逐条确认）

1. 拒绝码 **404**（与「对象不存在」逐字节一致，防存在性预言机）。
2. admin **不放行**跨用户读（最小权限；未来支持/审核工具另行确认并要求审计日志）。
3. `_sprite`/`_proxy` key 形态改造**执行**（内嵌源键 + 参数段）。
4. 签名 URL **不叠加**归属比对（维持能力凭据模型）。
5. avatarKey 引用校验**入范围**；canvas/asset 引用侧校验**不入**。

## 业务规则（依据行业惯例：S3 多租户 = 认证后强制对象归属比对；预签名 URL 为签发侧授权的能力凭据；存在性差异响应不可区分）

1. **会话凭据**：`/api/files/*` 请求经会话认证后，解析 requestedKey 的归属用户，归属 ≠ 会话用户 → 拒绝。拒绝响应与「对象不存在」完全一致（404 `files.file_not_found`，逐字节一致）。
2. **签名 URL 凭据**：key 绑定能力凭据，不叠加归属比对（持有有效签名即授权；签发仅面向无会话上游消费方）。两类凭据互不影响（spec storage-s3-backend 规则 6 的会话分支语义由本 Spec 细化，实施时在该 Spec 规则 6 处补一句交叉引用）。**并存语义**：同一请求会话与签名并存时按会话路径处理——会话成立即执行归属校验，签名仅在会话缺失时作为凭据。依据：签名本就只签发给无会话上游消费方，已认证会话携带他人签名没有合法场景，从严拒绝（fail-closed），且签名 URL 无会话单独使用不受影响。
3. **归属解析单点**：新增单一实现 `server/services/storage/ownership.ts`（`resolveKeyOwner(key): number | null`，依赖 backend.ts 前缀常量与 shared/url 的 key 形态知识），按命名空间返回归属 userId：
   - 内容对象 → 首段（严格形态校验后）；
   - `staging/{userId}/{uuid}` → 第二段；
   - `_cache/{tier}/{源键}`、`_posters/v{N}/{源键}` → 内嵌源键首段（内嵌源键可为内容键去扩展名，或 staging key——`w=` 对 staging 源的会话内缓存形态）；
   - 改造后 `_sprite/{源键}`、`_proxy/{源键}` → 内嵌源键首段；
   - 无一匹配（畸形 key、旧单向哈希形态）→ 返回 null → 调用方一律按无归属拒绝（fail-closed）。
   media-edit 工厂的私有 `keyBelongsTo` 撤销、改调本解析器。**行为变化（有意）**：本人派生/暂存源键由「一律 403」变为放行（内嵌自身属主，操作的是本人数据；旧规则只是首段匹配无法理解命名空间的副作用）；他人键仍 403；畸形键仍 403。
4. **admin**：MVP 不放行跨用户读（已确认）。
5. **avatarKey 引用接受边界**（updateUser，同事务内）：key 严格形态（现有 hashFromStorageKey）之外，追加 ① 内嵌 userId == 当前用户（resolveKeyOwner），② `file_objects` 查得该 (userId, hash)。任一不满足 → `UserAvatarKeyError` → 422，无账本/聚合写入。canvas/asset 引用侧不做（见非目标）。
6. **`w=` 缩放**：守卫对原始 requestedKey 执行（置于 `w=` 分支之前，无权请求不触发媒体生成）；命中缩放缓存时生成的 `_cache` 派生 key 由本人源键派生，归属天然继承，不二次校验。
7. **派生 key 形态改造**（`_sprite`/`_proxy`）：文件名由 `sha1(源键…).slice(0,32)` 改为内嵌源键 + 参数段——
   - `_sprite/{源键去扩展名}_c{count}v{SPRITE_VERSION}.webp`（帧数是唯一变化参数，格宽为模块常量；参数版本并入参数段保证升版自动失配）；
   - `_proxy/{源键去扩展名}_w{width}v{PROXY_VERSION}.mp4`（宽度因小源缩限而变化）；
   - 参数段形态固定（`_c\d+v\d+` / `_w\d+v\d+`），解析规则：去前缀、去扩展名、去参数段后须为「内容键去扩展名」或 staging 形态，否则无归属。
   收益：归属可解析（本 Spec 必需）。旧形态产物为可再生物：旧链接在新解析器下 fail-closed 404，前端按需重调路由生成（自愈），TTL 30 天清扫自然淘汰，不做迁移。

## 技术影响

- 新增 `server/services/storage/ownership.ts`（`resolveKeyOwner` 解析 + `isKeyOwner` 归属判定单点；files 读路由、media-edit 工厂、avatarKey 接受边界三处共用，fail-closed 语义内聚于判定）。
- 新增 `server/services/storage/derived-keys.ts`：四个派生命名空间的构造与解析**同址**（`cacheKeyOf`/`posterMasterKey` 自 resize-cache 迁入，`spriteKeyOf`/`proxyKeyOf` 新增，解析正则迁入）——构造端格式漂移即时失配于往返测试，不被读路由 fail-closed 静默化为缓存未命中。
- `server/http/routes/files.ts`：单点守卫（鉴权后、穿越 403 与 `w=` 分支前）+ 归属拒绝审计日志（logEvent `files/ownership_denied`，含 user 与 key；响应不变）。
- `server/http/routes/media-edit.ts`：删除私有 `keyBelongsTo`，改调解析器；错误码不变（403 `files.access_denied`）。
- `server/crud/user.ts`：avatarKey 校验追加两项（同事务，不新增事务）。
- `server/http/routes/frame-sprite.ts`、`video-proxy.ts`：key 构造改内嵌源键 + 参数段；`server/services/storage/video-frames.ts` 不变（outputPath 由路由传入）。
- `server/services/storage/backend.ts`：staging 严格形态正则从 upload-direct.ts 私有实现上移为 `STAGING_KEY_PATTERN` 导出（与归属解析共用同一形态知识，防第二份拷贝漂移）。
- shared/url.ts：新增 `storageKeyStem` 与 `STORAGE_KEY_STEM_PATTERN`（整键与 stem 两模式由共享 hash 对片段单源派生，配一致性交叉验证；「key 段结构知识单点于此」的既有约定）。
- `derived-cleanup`、迁移/审计的 `DERIVED_ROOT_PREFIXES` 分类：不变（前缀枚举逻辑兼容新形态）。
- files 路由守卫置于穿越 403 之前：会话路径下穿越/畸形键由归属 404 前置吸收（这些键解析不出属主）；签名路径仍走穿越 403。media-edit 的 StorageTraversalError 403 映射保留为纵深防线（严格形态 key 实际不可达）。
- 测试：ownership 解析器单测（全命名空间 + 畸形 fail-closed + userId 0 结构纯度）+ derived-keys 构造↔解析往返锁定（含 staging 源缓存与旧形态失配）+ files 路由级归属三态（本人 200/他人 404 与不存在逐字节一致/签名 URL 不受影响）+ 会话与签名并存按会话路径处理 + 归属拒绝审计日志断言（user+key）+ staging/_cache/_posters/改造后 sprite/proxy 归属 + 畸形 key fail-closed + avatarKey 归属/存在两态（在 user-avatar-ledger 真库测试追加）+ media-edit 本人派生源键放行 + 派生路由产物新形态文件名断言 + shared 两模式一致性交叉验证。

## 异常与边界

- 畸形/无归属 key：与对象不存在同响应（fail-closed，不可探测命名空间结构）。
- 顺序 userId 可枚举：key 非秘密，归属校验才是防线；不改 key 结构（见下方路径规范结论）。
- 同内容重传刷新 ext 元数据产生的旧 ext 孤儿对象：既有 audit 清单兜底，不在本 Spec。
- 旧形态 `_sprite`/`_proxy` 链接（前端缓存中的 URL）：404 后由前端重调路由自愈，无迁移、无兼容层。
- avatarKey 存在性检查与 GC 删除的极窄竞态窗口（检查通过后、事务提交前对象被 GC）：后果是惰性账本行（GC 候选排除 + audit 可观察），用户下次设置头像自愈；48h GC 宽限 + 同事务检查使窗口在实践中不可达，不为此加锁。
- 跨用户去重：维持 per-user 命名空间不去重（Dropbox 式全局去重存在确认数据攻击史，非行业默认）。

## 验收标准

1. 用户 A 会话请求用户 B 的内容对象/staging/派生 key → 404，与不存在对象响应逐字节一致。
2. A 请求自己的对象 → 200（redirect 302 / relay / Range 行为不变）；自己的 staging / `_cache` / `_posters` / 新形态 `_sprite` / `_proxy` key 同样放行。
3. 有效签名 URL 拉取 → 行为与现状一致（含过期/篡改拒绝），不叠加归属比对。
4. 畸形 key（无归属段、旧单向哈希形态）→ 404（files 会话路径）；media-edit → 403。
5. `w=` 缩放缓存行为不变（本人源命中缓存正常）；无权请求不触发缩放生成。
6. avatarKey：他人 key 或不存在 key → 422 `UserAvatarKeyError`，无账本/聚合写入；本人已上传 key → 正常。
7. `_sprite`/`_proxy` 新形态生成、TTL 清扫、播放/预览回归正常；旧形态 key 无法被读路由解析（404）。
8. 归属拒绝写审计日志（user + key），响应不受影响。
9. media-edit 工厂与 files 读路由共用同一归属解析器，私有 keyBelongsTo 删除。
10. typecheck / lint / 全量测试串行通过；无向后兼容层。

## 存储路径行业规范评估（用户问询，结论性记录）

当前布局符合行业规范，无需变更：

| 元素 | 现状 | 行业对照 |
| --- | --- | --- |
| userId 根前缀 | `{userId}/…` | S3 多租户标准形态；per-tenant 生命周期/配额/审计/删除（GDPR 式）一根前缀完成 |
| hash[:2] 分片 | `{hash[:2]}/{hash}` | git objects 同款（百万级对象实证）；256 桶扇出充足；S3 已无 per-prefix 吞吐限制 |
| ext 在 key | `{hash}{ext}` | 两种主流形态之一（纯 CAS 不放 ext / CDN 类放 ext 换 MIME 直读）；换 ext 重传的旧 ext 孤儿由 audit 网兜底，可接受 |
| staging 独立根 | `staging/{userId}/{uuid}` | 直传暂存与内容命名空间分离是直传系统惯例 |
| 派生独立根 | `_cache/_posters/_sprite/_proxy` | 可再生物与内容分离，迁移/备份不校验派生——本项目迁移脚本正是此设计 |
| 顺序 id 可枚举 | userId 非随机 | key 非秘密（归属校验为防线），行业顺序租户 id 常见，不构成路径问题 |
| per-user 不去重 | (userId, hash) 命名空间 | 比 Dropbox 式全局块去重更安全（避免 dedup-oracle 确认数据攻击），属主流安全选择 |

唯一与「key 应自描述归属」存在张力的是 `_sprite`/`_proxy` 的单向哈希文件名，已由本 Spec 业务规则 7 处理。

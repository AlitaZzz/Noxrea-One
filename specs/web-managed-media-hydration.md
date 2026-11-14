# Web 托管媒体水合一致性（Managed Media Hydration Parity）

状态：已确认（2026-11-06 创建；同日用户明确指示按方案 B 实现；2026-11-08 用户正式确认本 Spec。实现与验证记录、验收缺口见「当前状态」）

上游与关联：

- [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md)（已确认）：托管媒体解析层、规则 3.2（缓存（内存 + 客户端持久化，2026-10-26 修订））、规则 3.4（分发形态学习）。本 Spec 只约束**解析结果的读取时机**，不改变描述接口、签名、缓存键、持久化格式与淘汰规则；该 Spec 规则 3.2（缓存（内存 + 客户端持久化，2026-10-26 修订））已增加读取时机指针（2026-11-08）。
- [web-module-contracts.md](web-module-contracts.md)（已实现）规则 4（`entities/user` 状态与生命周期）：`entities/user` 的 SSR cookie 契约与 `CachedUserProvider`。本 Spec 只消费该契约，不改变用户状态归属。
- [canvas-media-loading-skeleton.md](canvas-media-loading-skeleton.md)（已确认）：画布媒体的骨架与加载态。本 Spec 不改变画布侧的加载调度，只约束水合首帧。

## 目标

1. 消除「服务端已输出的托管媒体」在客户端水合时的 React hydration mismatch。
2. 保留客户端持久化缓存的既有收益：同一标签页刷新后水合完成即出图，不产生描述请求。
3. 把「首帧快照一致性」固化为解析 Hook 的契约，使未来任何参与 SSR 的托管媒体自动受保护，而不是逐个调用点打补丁。

## 范围

1. `useFileAccessUrl` 的首次渲染语义：渲染期缓存探测与客户端缓存的读取时机。
2. 所有可能参与 SSR 的托管媒体渲染点（当前确认：项目页头像；共享组件 `ResolvedImage` / `ResolvedVideo`）。
3. 回归测试与浏览器验收：覆盖 `signed` 持久化命中与未命中、`stream` 后端、清空 IndexedDB 后首次访问。

## 非目标

- 描述接口、签名 TTL/对齐窗口、`refreshAt`、主动刷新与失败重试（`storage-signed-direct-delivery.md` 规则 2（访问描述接口）、规则 3（前端解析）、规则 4（签名常量与缓存头））。
- IndexedDB 的库名、键结构、条目上限与账号作用域清理（[storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 规则 3.2（缓存（内存 + 客户端持久化，2026-10-26 修订））不变）。
- 取消 `signed` 持久化、改为每次刷新重新描述。
- 服务端为 SSR 媒体签发/下发描述（改变「客户端换取描述」的分层；若未来确需，另立 Spec）。
- 当前不在 SSR 输出中的媒体（如项目封面、资产卡片）：它们遵守同一 Hook 契约，但不需要专项迁移或验证。

## 业务规则

1. 同一输入下，服务端输出与客户端水合首帧必须一致；首帧之后的状态更新不属于水合比较范围。
2. 托管媒体在水合首帧一律「未解析」（`url = undefined`），由调用方 fallback 承担首帧内容；即使客户端在渲染前已从内存、IndexedDB 或形态学习取得可用地址，也不得在首帧使用。
3. 「未解析」不是失败：首帧不展示失败态、不发起描述请求；解析由水合后的外部快照或 effect 驱动。
4. 水合完成后允许同步命中缓存并立即出图，不发描述请求；持久化缓存的既有收益不得回退。
5. 纯客户端挂载（无 SSR，例如弹层、浮层、SPA 导航后新挂载的组件）不受首帧未解析约束，首帧可直接命中缓存。
6. 判定依据必须是 React 水合阶段语义，不得以 `typeof window`、计时器或「挂载后第 N 帧」替代，也不得用 effect 置真的 mounted 状态作为门闩。
7. 任何可能参与 SSR 的托管媒体必须复用共享解析 Hook；不得自行读 IndexedDB、直接拼预签名地址或在组件内实现第二套缓存。
8. 不得用 `suppressHydrationWarning`、整块 `dynamic(ssr: false)` 或删除服务端渲染来掩盖差异；若某媒体确实不需要 SSR，由调用方明确选择仅客户端渲染并说明首屏策略。
9. 账号切换、登出清空的既有语义不变；会话切换属于客户端重渲染，可直接使用新作用域缓存。

## 背景与已验证事实

### 报错现象（2026-11-06，真实浏览器）

- Next.js 16.4.2 Turbopack 开发环境，`/project` 页面控制台报 `Recoverable Error: Hydration failed because the server rendered HTML didn't match the client`。
- 组件栈：`ProjectPage → ProjectListPage (ProjectListPage.tsx:172:17) → ResolvedImage (ResolvedMedia.tsx:119:5) → img`。
- React 差异（`+` 客户端 / `-` 服务端）：
  - `+ <img src="http://10.10.10.2:9833/noxrea/1/ad/addc5…">`
  - `- <span class="flex size-full items-center justify-center bg-primary text-primary-foreground">`

### 三方对照（已验证）

1. **同 cookie 重新请求 SSR HTML**：头像区域输出 `<span …>N</span>`，整段不含任何 MinIO 地址；用户名 `noxrea` 正常直出。说明服务端持有 `avatarKey`，只是解析不出最终地址。
2. **浏览器控制台**：客户端首帧已经渲染出 `http://10.10.10.2:9833/noxrea/…` 的 `<img>`，与 SSR 的 fallback `<span>` 不一致。
3. **IndexedDB 实查**：库 `noxrea-file-access`、store `signed` 中存在 `cacheKey = 1/ad/addc5abd0597a11c21f…`、`scope = "1"` 的记录；`refreshAt = 1793938320`，检查时 `now ≈ 1793937674`，**未过期**；`savedAt` 约两小时前（上一次访问写入）。

### 代码链（已通读）

1. 根布局从 `noxrea-user` cookie 解析用户并经 `CachedUserProvider` 注入（[layout.tsx:42](../web/src/app/layout.tsx:42)、[layout.tsx:53](../web/src/app/layout.tsx:53)）；`useCurrentUser()` 在 store 初始化前返回这份 SSR 缓存（[UserContext.tsx:24](../web/src/entities/user/UserContext.tsx:24)）。因此 `ProjectListPage` 的 `<ResolvedImage value={user?.avatarKey} …>`（[ProjectListPage.tsx:172](../web/src/features/project/components/ProjectListPage.tsx:172)）参与 SSR。
2. 服务端：`useFileAccessUrl` 初始 `state = null`；SSR 不执行 effect；服务端进程没有 IndexedDB，`hydratePersisted()` 因无账号作用域直接返回（[persisted.ts:63](../web/src/lib/file-access/persisted.ts:63)）；内存缓存为空。`peekMediaAccess` 返回 `null`，`ResolvedImage` 渲染调用方提供的 fallback（[ResolvedMedia.tsx:115](../web/src/components/media/ResolvedMedia.tsx:115)）。
3. 客户端：用户仓库在模块加载时从同一 cookie 建立账号作用域（[store.ts:229](../web/src/entities/user/store.ts:229)），触发 file-access 会话变更；`hydratePersisted()` 在水合渲染前把未过期记录装入内存副本。
4. 客户端首帧：`useFileAccessUrl` 在渲染期同步探测缓存，命中即 `setState`（[use-file-access-url.ts:99](../web/src/lib/use-file-access-url.ts:99)）；`peekMediaAccess` 依次尝试 stream 学习、内存缓存、持久化副本（[index.ts:85](../web/src/lib/file-access/index.ts:85)），本次命中持久化副本（[index.ts:92](../web/src/lib/file-access/index.ts:92)）。于是客户端**水合首帧**直接输出 `<img>`，与 SSR 的 `<span>` 不同。

### 触发条件

同时满足才触发：

1. 托管媒体在 SSR 输出中（当前为 cookie 注入用户后的头像）。
2. `signed` 直连分发（S3/MinIO 后端）。
3. 此前访问持久化过该媒体的签名描述，且记录仍在寿命内（判定点为 `refreshAt`，见 `expiryOf`）。
4. IndexedDB 载入先于水合渲染完成。这是赛跑，但载入在模块求值阶段启动、水合在其后，常态偏向命中；清空 IndexedDB、首次访问、`local`/`stream` 后端不会触发。

### 影响

- React 将其归为可恢复错误：丢弃该子树的服务端 HTML 并在客户端重建，头像最终显示正常；代价是重复渲染、开发环境控制台噪声，并可能掩盖后续真实的水合错误。
- 这不是数据或安全问题；属于渲染契约缺陷，只要「SSR 托管媒体 + 首帧同步读客户端缓存」并存就会复发。

### 覆盖缺口

现有测试均为客户端渲染（`web/src/__tests__/lib/file-access.test.ts`、`web/src/__tests__/lib/UseFileAccessUrl.test.tsx` 等），没有 SSR / hydration 用例，因此该缺陷未被测试捕获。

## 方案

### 1. 首帧快照契约

1.1 **首帧一致**：对同一输入，服务端输出与客户端**水合首帧**必须一致；首帧之后的状态更新不属于水合比较范围，可以正常改变 DOM。

1.2 **首帧未解析**：托管媒体在水合首帧一律为「未解析」，`url = undefined`，由调用方 fallback 承担首帧内容。即使客户端在渲染前已经从内存、IndexedDB 或模块级形态学习取得可用地址，也不得在首帧使用。

1.3 **未解析不是失败**：首帧不展示失败态、不发起描述请求；解析由水合后的外部快照或 effect 驱动。

1.4 **水合后命中缓存**：水合完成后允许同步命中缓存，内存缓存或持久化副本命中时立即出图、不发描述请求（`storage-signed-direct-delivery.md` 规则 3.2（缓存（内存 + 客户端持久化，2026-10-26 修订））/ 规则 3.4（分发形态学习）的收益不变）。

1.5 **独立挂载不受约束**：客户端独立挂载（无 SSR，例如弹层、浮层、SPA 导航后新挂载的组件）不受 1.2 约束，首帧可直接命中缓存。不得为了规避水合而在所有客户端挂载上统一延迟一帧，那会把骨架闪烁引入原本同步出图的路径。

1.6 **hydration 阶段语义**：判定依据必须是 React 的 hydration 阶段语义，不能用 `typeof window`、计时器或「挂载后第 N 帧」替代：`typeof window` 在客户端水合首帧同样为真，无法区分 SSR 基线与纯客户端渲染。

### 2. 实现约束

2.1 **根因修复（首选）**：解析结果经外部变更信号 + `useSyncExternalStore` 读取。`getServerSnapshot` 恒返回「未解析」；`getSnapshot` 返回该 Hook 的展示快照（含 `url` / `delivery` / 寿命字段），首次取到非空结果后按源冻结、此后返回同一引用；来源变化（包括新来源尚未解析）或会话切换时重新取，旧来源的冻结不得残留。缓存写入、持久化载入、形态学习与会话重置时通知订阅者；淘汰不通知——过期条目在读取时已不可见，上界淘汰只影响之后的读取，已展示的值由消费方的按源冻结持有。React 在水合渲染使用 server snapshot、水合结束后切换到客户端快照，因此 1.2 / 1.4 / 1.5 同时成立；渲染不再直接读取模块级可变缓存，也不再以渲染期 `setState` 出图。

快照的稳定性与寿命都由消费方持有，解析层不保存第二份派生结果：签名地址只存在于缓存与持久化副本中，随各自的会话重置失效（签名地址是能力凭据，不得跨登出 / 换号残留）。因此会话重置不需要额外的「清快照」步骤，也不存在独立的派生存储可被遗漏——冻结引用随组件卸载或会话切换释放。

2.2 **最小守卫（备选，不作为根因修复）**：只增加「是否已水合」的外部快照（`getServerSnapshot = false`、客户端 `true`），保留现有渲染期 `peekMediaAccess` 与 `setState`。它能消除本次 mismatch，但「渲染期读可变缓存」的模式仍在：换一个消费点、或并发渲染下发生快照撕裂时仍可能复发。仅在暂不改动解析层时采用。

2.3 effect 中的解析路径不变：仍先用 `peekMediaAccess` 短路已命中项，否则 `resolveMediaAccess` 内部 `awaitHydration()` 等待持久化载入后再判缓存（[index.ts:125](../web/src/lib/file-access/index.ts:125)）。变更信号只触发订阅方重查快照，不改变解析与批量调度。

2.4 禁止用「effect 中置真的 mounted 状态」作为门闩：客户端独立挂载也会被延迟一帧，与 1.5 冲突；必须使用能区分服务端/水合与纯客户端渲染的快照语义。

2.5 调用方契约不变：`ResolvedImage` / `ResolvedVideo` 继续「无地址渲染 fallback，有地址渲染元素」。参与 SSR 的调用方必须提供非空 fallback（当前头像已提供），否则首帧空白——这仍不是水合错误，但属于首屏缺位。

2.6 服务端不读取客户端持久化缓存，不为该媒体签发地址；客户端也不得在首帧直接读 IndexedDB 或自行拼接签名地址。

### 3. 与持久化缓存的关系

3.1 持久化缓存保留，只改变它**参与渲染的时机**：水合首帧不参与，水合后参与。刷新后的描述请求数与浏览器缓存命中行为不应回退。

3.2 账号切换、登出清空的既有语义不变；会话切换发生的是客户端重渲染，不是水合，允许立即使用新作用域缓存。

### 4. 新增 SSR 托管媒体

4.1 任何可能服务端渲染的托管媒体必须复用共享解析 Hook；不得自行读 IndexedDB、直接拼预签名地址或在组件内实现第二套缓存。

4.2 不得用 `suppressHydrationWarning`、整块 `dynamic(ssr: false)` 或删除服务端渲染来掩盖差异。若某媒体确实不需要 SSR，应由调用方明确选择仅客户端渲染，并说明首屏策略，而不是在共享组件里统一关闭 SSR。

## 技术影响

### 前端

- [use-file-access-url.ts](../web/src/lib/use-file-access-url.ts)：首帧地址改由 `useSyncExternalStore` + 外部变更信号提供，移除渲染期缓存探测与渲染期 `setState`；解析 effect 仍以 `peekMediaAccess` 短路已命中项。每个 Hook 在首次取到非空结果后按源冻结展示值——冻结同时满足 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 规则 3.8（主动刷新）的「后台刷新只更新缓存与新鲜地址槽、不替换已挂载元素地址」约束与 `getSnapshot` 的引用稳定性。冻结的寿命绑定当前来源：每次读取都归一到当前来源，来源变化后的首次读取按新来源重建（未命中则为空），换回旧源时重新读取缓存而不是复用旧冻结；会话切换时监听器立即释放冻结。主动刷新、重试预算、`reloadToken` 的既有语义不变。
- [access.ts](../web/src/lib/file-access/access.ts)：只承载同步读取（`peekMediaAccess`）与描述→访问结果的映射，不保存派生存储、不持有账号数据，因此没有会话重置职责。
- [file-access/index.ts](../web/src/lib/file-access/index.ts)、[change-signal.ts](../web/src/lib/file-access/change-signal.ts)、[cache.ts](../web/src/lib/file-access/cache.ts)、[persisted.ts](../web/src/lib/file-access/persisted.ts)、[state.ts](../web/src/lib/file-access/state.ts)：缓存写入、持久化载入、形态学习、会话重置时广播变更信号（淘汰不广播，见 2.1）；持久化写入是缓存条目的设备镜像，由缓存写入唯一通知，不重复广播。持久化命中判定自带账号校验，不会读到其他账号的副本，会话重置顺序因此不再是正确性前提。会话重置顺序为作用域 → 主动刷新 → 缓存 → 持久化 → 批次 → 载入，只清属于账号作用域的真相。协议、缓存键、持久化格式不变，`peekMediaAccess` 保持纯同步、无副作用。
- [ResolvedMedia.tsx](../web/src/components/media/ResolvedMedia.tsx)：无行为变更，继续在无地址时渲染 fallback。
- [ProjectListPage.tsx](../web/src/features/project/components/ProjectListPage.tsx)：无变更；头像 SSR 输出 fallback，水合后出图。
- [layout.tsx](../web/src/app/layout.tsx)、[UserContext.tsx](../web/src/entities/user/UserContext.tsx)、[store.ts](../web/src/entities/user/store.ts)：SSR 用户契约与账号作用域建立不变。
- 测试：
  - 新增 Hook 契约用例：预热持久化副本后，server snapshot / 水合首帧仍为未解析；水合后同一组件命中缓存且不发描述请求。
  - 新增变更信号用例：缓存写入 / 重置、持久化载入、形态学习、会话切换都通知订阅者；同步读取立即可用，会话重置后旧账号地址不可读。
  - 新增重渲染隔离用例：无关 key 的缓存写入广播信号后，已挂载 Hook 的冻结快照引用不变，不产生重渲染。
  - 新增 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 规则 3.8（主动刷新）冻结用例：缓存命中挂载的 Hook 在 `refreshAt` 后台刷新后，缓存换成新地址，而展示地址在通知与任意父级重渲染后仍保持旧值（移除按源冻结即失败）。
  - 新增换源冻结用例：缓存命中挂载时 A → 未解析的 B → A，换回 A 必须重新读取缓存，旧冻结不得残留（移除「读取时把冻结归一到当前来源」即失败）。
  - 新增缓存命中会话切换用例：冻结在账号切换时立即释放，旧账号地址在新描述返回前已清空。
  - 新增持久化命中作用域用例：账号已更新而副本尚未清空时，旧账号条目不可命中（命中点自带账号校验）。
  - 新增 React SSR + hydration 集成用例（`react-dom/server` + `hydrateRoot`，模拟已预热的持久化缓存）：断言服务端 HTML 为 fallback、hydration 无 mismatch、水合后出现最终地址。
  - 新增纯客户端挂载用例：无 SSR 时首帧直接命中缓存，不额外等待一帧（防止 2.4 的退化）。
  - 现有 `file-access` / `UseFileAccessUrl` / `ResolvedMedia` 用例全部保持通过。

### 服务端、数据与部署

- 无服务端接口、数据库、存储配置或部署变更。
- 无新增运行时依赖。

## 异常与边界

- **持久化载入晚于水合**：首帧 fallback；effect 的 `resolveMediaAccess` 等待载入完成再判缓存，命中则不发描述请求，未命中则正常描述。两种时序都不产生水合差异。
- **首次访问 / 清空 IndexedDB**：首帧 fallback，水合后发出一次描述请求并出图；与当前行为一致，只是首帧不再提前出图。
- **`local` / `stream` 后端**：新文档在首次描述响应前没有形态学习结果，本就不会首帧出图；学习后组件在客户端重新挂载时可首帧出图（无 SSR，符合 1.5）。SSR 页面刷新时服务端没有学习结果，两端一致。
- **账号切换 / 登出**：清空缓存与在途请求的既有语义不变；随后的渲染是客户端更新，不属于水合，可以直接使用新作用域缓存。
- **同一页面多个同源媒体**：各自 Hook 独立判断水合阶段；水合后共享解析层缓存与批量合并，不增加描述请求。
- **StrictMode 双渲染**：外部快照在服务端与水合阶段恒为未解析，双渲染不改变首帧结果。
- **未来 React / Next 版本**：`useSyncExternalStore` 的 server snapshot 语义是公开契约；集成用例锁定行为，不依赖内部实现。
- **首屏观感**：SSR 本来输出 fallback，因此水合后一帧再出图不构成「图片变骨架」的回退；若未来要求头像与 SSR 同帧出现，只能由服务端下发地址，属于本 Spec 非目标。

## 验收标准

### 测试与静态检查

- Hook 契约：持久化副本已预热时，`getServerSnapshot` / 水合首帧返回未解析；水合完成后返回缓存地址，且描述请求数为 0。
- SSR + hydration 集成：服务端 HTML 与客户端水合首帧一致（无 mismatch），水合后地址生效；控制台无 hydration 警告。
- 纯客户端挂载：首帧命中缓存，不出现额外的骨架帧。
- 现有解析层、Hook、`ResolvedMedia`、项目页相关用例通过；`typecheck`、`lint`、相关 Vitest 串行通过（单 worker）。

### 浏览器实测（signed 后端）

- 预热条件（IndexedDB 中存在未过期头像描述）下刷新 `/project`：无 `Hydration failed` / recoverable error；水合首帧头像为 fallback，水合后出图；描述请求数为 0。
- 清空 `noxrea-file-access` 后刷新：无 hydration 错误；水合后产生描述请求并出图。
- 切到 `local` / `stream` 后端刷新：无 hydration 错误。
- 纯客户端路径回归：打开包含头像菜单、项目封面等客户端挂载的媒体，首帧不出现新增骨架闪烁。

## 待确认事项

（无——2026-11-08 已按用户确认回写：`storage-signed-direct-delivery.md` 规则 3.2 增加本 Spec 规则 1.2、1.4 的读取时机指针；规则正文仍以本 Spec 为唯一权威，引用形式遵循 `AGENTS.md` 十二.3.4。原「实现方案 B / 水合后出图时机」两项已于 2026-11-06 决定并落地，决策与实施记录见「当前状态」。）

## 当前状态

- 2026-11-06：创建本 Spec；根因已实测复现（控制台错误、同 cookie 的 SSR HTML、IndexedDB 记录三方对照），代码链已通读。
- 2026-11-06：用户追问 A/B 的根因层级；结论为 B（解析结果外部存储化 + server snapshot）是根因修复，A 仅为最小守卫。
- 2026-11-06：用户明确指示按 B 实现：
  - 解析层新增 `change-signal` 订阅；内存缓存写入/重置、持久化载入/写入/重置、形态学习、作用域切换均通知订阅者；`access.ts` 只承载同步读取，`index.ts` 只做编排。
  - `useFileAccessUrl` 首帧改由 `useSyncExternalStore` 读取，`getServerSnapshot` 恒返回未解析；移除渲染期缓存探测与渲染期 `setState`；effect 仍以 `peekMediaAccess` 短路已命中项。每个 Hook 按源冻结首次取到的非空结果，快照引用因此稳定，[storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 规则 3.8（主动刷新）的后台刷新不替换已挂载地址；换源与会话切换时重新取快照。
  - 新增测试：变更信号单元用例、重渲染隔离用例、SSR + hydration 集成用例、纯客户端首帧命中用例；既有 Hook / 解析层用例保持通过。
- 2026-11-06（评审后根因修复）：代码评审指出两处硬性问题并已修复——
  1. 解析层曾保存 per-key 派生快照 `mediaAccessSnapshotOf`，其寿命独立于来源，只能在会话重置清单里追加一次清理——属于补丁式修复。已删除该派生存储：`getSnapshot` 直接同步读取来源，引用稳定性与 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 规则 3.8（主动刷新）由 Hook 的按源冻结同时保证；旧账号地址只存在于缓存 / 持久化副本中，随其既有会话重置失效。回归用例锁定「无关媒体缓存写入不重渲染」与「会话切换后旧账号地址不可读」。
  2. 「按源冻结」缺少回归用例，删除冻结逻辑时既有用例全绿。修复：新增缓存命中挂载 + 后台刷新 + 强制重渲染用例，移除冻结即失败。
  - 两处修复均已用临时回退验证用例可复现失败，恢复后聚焦用例通过。
- 验证（本轮，已执行）：`tsc --noEmit` 通过；`npm run lint` 0 error（6 个既有 `no-img-element` warning）；聚焦 4 个文件 81 用例通过；web 全量 206 文件 / 1637 用例通过（`--maxWorkers=1`）。「无关媒体缓存写入不重渲染」用例经临时回退验证可复现失败：移除按源冻结后 React 以 `Maximum update depth exceeded` 失败（不稳定的 `getSnapshot` 本身就是硬错误，不只是重渲染开销）。
- 2026-11-06（两轴评审后的第二轮根因修复）：评审指出三处硬性问题，均按根因修复——
  1. 按源冻结的寿命没有绑定来源：换到未解析媒体时旧冻结保留，换回旧源会复用旧地址（违反 2.1「来源变化时重新取」）。修复：`getSnapshot` 每次读取都把冻结归一到当前来源——来源未变返回冻结，来源变化即按当前来源重建（未命中则为空）；换回旧源时重新读取缓存，而不是复用旧冻结。
  2. 持久化命中判定不校验账号：会话切换先更新账号、再依次重置，中间的通知窗口可读到旧账号签名地址。修复：命中点直接比对记录作用域与当前账号，重置顺序不再是正确性前提。
  3. 每条描述在缓存写入与持久化写入各通知一次，批量写入的通知翻倍。修复：持久化是缓存条目的设备镜像，由缓存写入唯一通知；`persistDescriptor` 不再广播。
  - 同时按现状修正 Spec 2.1：淘汰不通知。过期条目在读取时已不可见，上界淘汰只影响之后的读取，已展示的值由消费方的按源冻结持有，通知没有订阅方可观察的效果。
- 验证（第二轮，已执行）：`tsc --noEmit` 通过；`npm run lint` 0 error（6 个既有 warning）；聚焦 5 个文件 86 用例通过；web 全量 207 文件 / 1642 用例通过（`--maxWorkers=1`）。三处修复均经临时回退验证用例可复现失败：移除「冻结归一到当前来源」→ 换源用例在中间源处失败；移除会话监听里的冻结释放 → 账号切换用例立即断言失败；移除持久化账号校验 → 作用域用例失败。
- 浏览器验证沿用 B 实现时的结论（signed 后端刷新 `/project` 无 hydration 错误、无 `/api/files/access` 请求）；两轮评审修复均只改动解析层 / Hook 的会话与冻结生命周期，未再开浏览器复验（预览页停在用户画布），由上述聚焦用例覆盖。
- 未验证：`local` / `stream` 后端的浏览器路径；清空 IndexedDB 后刷新（未删除用户现有缓存）；生产构建。
- 2026-11-07（评审后文档修复）：按 AGENTS 十二.3.2 补齐「业务规则」章节，规则与「方案」1.x / 2.x / 3.x 一致，不改变已实现行为与状态。
- 2026-11-08 用户确认本 Spec，状态由「待确认」改为「已确认」。确认范围为业务规则、接口契约与技术方案，不含数据库变更、部署、提交或推送授权；待确认事项收敛为规则 3.2 的文档交叉引用（不影响本 Spec 实现范围），该项已于同日执行，见下条。
- 2026-11-08 交叉引用落地（用户确认）：`storage-signed-direct-delivery.md` 规则 3.2 增加本 Spec 规则 1.2、1.4 的读取时机指针；`AGENTS.md` 十二.3 新增「规范条款单一权威」约定（第 4 条）。规则正文仍以本 Spec 为唯一权威，不复制、不改写。
- 未提交、未推送。验收缺口（`local` / `stream` 后端浏览器路径、清空 IndexedDB 后刷新、生产构建）与提交状态见上；全部验收项通过且实现代码提交并经用户确认后方可改为「已实现」。已确认的 `storage-signed-direct-delivery.md` 已按约定在规则 3.2 回写读取时机指针。
- 2026-11-08 规则标题补齐（仅文档）：为规则 1.1–1.6 增加粗体标题，供 `storage-signed-direct-delivery.md` 规则 3.2 按 `AGENTS.md` 十二.3.4 精确引用；规则语义未变。状态保持「已确认」。
- 2026-11-08 引用格式补齐（仅文档）：本 Spec 对 `storage-signed-direct-delivery.md` 规则 2 / 3 / 4 与规则 3.2 / 3.4 的引用统一为「文件名 + 规则编号 + 规则标题」，规则 1.4 同步；规则正文归属与语义未变。状态保持「已确认」。
- 2026-11-08 状态行按实际授权顺序改写（仅文档）：明确 2026-11-06 用户指示按方案 B 实现、2026-11-08 正式确认，消除「先实现后确认」的歧义；实现范围、验收缺口与状态均不变。
- 2026-11-09 六轮评审修复（仅文档）：上游 `web-module-contracts.md` 引用补齐规则 4（`entities/user` 状态与生命周期）；`storage-signed-direct-delivery.md` 规则 3.2 / 3.8 的引用补齐文件名与精确标题（含技术影响与状态记录中遗漏的 3.8 引用），符合 `AGENTS.md` 十二.3.4；规则语义与验收不变，状态保持「已确认」。

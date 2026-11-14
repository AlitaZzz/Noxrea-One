# Web Module Contracts（前端模块契约与依赖边界）

状态：已实现（2026-11-14 验收 7 随 canvas Spec 验收 12 通过而收口、经用户授权设置；2026-11-04 起草；2026-11-04 二次修订：明确项目写互斥归属、`entities/user` 与 `entities/director` 公共契约、`components/media` / `components/model` 下沉范围、项目 API 与 `adoptProject` 拆分；2026-11-04 三次修订：补齐资产库原始批量上传与共享音视频组件归属，清除 `features/assets → features/canvas` 残留导入；同日交叉核对 `features/settings`、`clamp01` 与 `uploadOne` 通知契约；2026-11-04 四次修订：按审核结论修正分层元素、导演类型归属、项目 API 签名、canvas 公共 API 签名、保存依赖倒置与悬浮预览归属；2026-11-04 五次修订：按二次审核结论修正 `CanvasSaveSource` 注册时机、`assetsDialog` slot 开关归属、`addAsset` 签名与文件夹纯函数归属、`AssetBrowserPanel` 拖拽路径及提示词预加载的可用性语义；2026-11-04 六次修订：按三次审核结论统一 `canvas-save-source.ts` 落位与注册时机表述；2026-11-04 用户确认；2026-11-09 七次修订：画布保存改为静态无环分层（文档 store 叶子 + 保存意图 + React 适配），删除 `CanvasSaveSource` 注册表，经用户授权调整核心架构）

## 背景

2026-11-04 的前端结构盘点确认：`web/eslint.config.mjs` 目前只把 `app / feature / ui / store / lib` 作为 `boundaries` 元素类型，`feature → feature` 被整体放行；`features/*/index.ts` 也没有承担“模块契约”职责。

已验证的现状：

- `features/assets/index.ts`、`features/auth/index.ts`、`features/director/index.ts` 直接导出 store（`useAssetsStore`、`useAuthStore`、`useDirectorStore`）以及内部组件，调用方拿到的是实现而不是行为契约。
- 跨 feature 深导入普遍存在：`features/settings/ApiSettingsModels.tsx` 导入 `features/model/ModelIcon`；`features/canvas/controls/ProjectToolbar.tsx` 导入 `features/auth/components/UserMenuPopover`；`features/canvas/controls/CanvasControls.tsx` 导入 `features/auth/store`；`features/canvas/explorer/CanvasExplorer.tsx` 深导入 assets 组件、store、hook；`features/canvas/nodes/*` 直接读 assets/store；`features/canvas/stores/canvas-store.ts` 依赖 `features/project/save-manager`。
- `features/project` 反向承担了画布会话与持久化：`use-canvas-session.ts`、`save-manager.ts`、`canvas-lease.ts`、`session-expired-store.ts` 直接导入 canvas store/types；`features/project/types.ts` 直接导入 canvas 节点/视口类型；`ProjectListPage` 导入 canvas `flushAndWait`。这些是画布文档会话/保存职责，不是项目列表职责。`save-mutex.ts` 不属于画布保存：项目改名/封面与画布保存共用该写通道，应归 `entities/project`。
- `features/director` 的 `DirectorOverlay` / `DirectorViewport` 直接导入 canvas store、canvas types 与 canvas upload；`features/auth/AvatarCropModal` 导入 canvas `uploadOne`。导演台与头像上传都属于消费方，不应反向依赖 canvas 内部。
- `features/media` 实际是无业务状态的共享媒体渲染能力，却被 auth/assets/canvas/director 等多个 feature 以 `@/features/media/...` 深导入，属于“共享能力放错层”。其中 `ResolvedHoverMedia` 只依赖 `components/ui` 与 `lib`，可整体下沉；`AssetHoverPreview` 虽位于 assets，但只对 `AssetItem["mediaType"]` 做类型引用、不依赖任何资产状态，且 canvas Explorer 的资产视图同样直接使用它，因此在 `components/media` 泛化为 `MediaHoverPreview`，assets 侧删除包装组件。
- `features/assets` 仍反向依赖 canvas，且此前的迁移范围未覆盖：`AssetCreateDialog` 使用 canvas `runMediaUpload` 的 raw sink 与 `pick-files` 的 `expandAccept` 完成批量原始上传；`AssetInspector` 使用 canvas `VideoPlayer` 与 `AudioWaveform` 做预览。前者是无画布副作用的“Blob → 远程引用”上传，后者是可共享的媒体播放 UI；仅迁移 `uploadOne`、`AssetsDialog` 插入回调和 `createAssetNode` 不足以让 assets 脱离 canvas。
- `providers/BatchConnectContext.tsx` 位于 app 级 Provider 目录，却直接导入 `features/canvas/controls/use-batch-connect-drag`，说明 app 组合层与 feature 内部边界尚未建立。
- `web/src/app/(app)/canvas/[projectId]/page.tsx`、`web/src/providers/AppProviders.tsx` 等 app 层代码也直接导入 feature 内部模块；页面与 Provider 实际承担了越过契约的装配。
- `lib/model-store` 当前承载模型库业务状态，是 shared 层中的存量例外；本期不扩大迁移范围，后续按 `entities/model` 评估。`features/model` 本身只有模型选择/参数 UI 与纯函数、不持有状态，应作为 shared UI 下沉 `components/model`，否则 canvas 无法在 feature 隔离规则下继续使用。

这套模型在 canvas 上已经形成耦合枢纽；历史讨论中的“方案 A / 方案 B”不再作为备选。本 Spec 定义目标架构与执行规则；canvas 作为第一个试点，按本 Spec 落地。

行业定位：这是 **FSD-lite + 模块化单体 + Nx 风格模块边界 + Bulletproof React + ports/adapters** 的组合，不是单一标准的“官方架构”。其中 `entities` 层来自 FSD；严格 feature 隔离比多数 Next.js 项目更严；ports/slots 只用于 UI 能力注入，不用于领域数据。采用它是因为 canvas、agent、workflow 等核心领域的长期维护成本已经超过一次性迁移成本。

## 目标

1. 建立单向依赖：`app → features → entities → shared`；任何模块不得反向依赖上层，feature 之间不得直接依赖。
2. 每个 feature/entity 只通过根目录 `index.ts` 暴露公共契约；禁止深导入、`export *` 和实现泄漏；类型导入同规则。
3. 跨 feature 共享的领域状态与规则归 `entities`；feature 只保留自身消费的领域状态与 UI 状态；app 只做路由、会话与页面组合。
4. 跨 feature 的 UI 能力通过显式 props/slots/ports 由 app 注入；不引入事件总线、DI 容器或全局可变注册表。
5. 规则必须由 lint 与架构测试执行，不能只写在文档里；存量违规以可缩小的基线 ratchet 管理，新增违规立即失败。
6. 不改变用户可见行为、接口契约、持久化数据与性能特征；不为分层做无关 UI 改版。

## 范围

- 新增 `web/src/entities/*` 及其公共契约：至少覆盖 canvas 直接依赖的 `asset`、`project`、`director`、`user`；`task` 是否独立成 entity 由实现盘点后决定。
- 调整 `features/*/index.ts` 的公共 API：移除 store、内部组件、内部 hook 的对外导出；feature UI 改为消费 entities 公共 API。
- 画布文档与会话归属纠正：`use-canvas-session`、`save-manager`、`canvas-lease`、`session-expired-store` 与画布文档类型（`CanvasProject` / `CanvasData` / `CanvasDataDelta` / `HistorySnapshot` / `ClipboardData`）从 `features/project` 迁入 `features/canvas`；`features/project/store.ts` 的 `adoptProject` 拆为 entity 的项目摘要 upsert 与 canvas 的文档校验/采纳；`entities/project` 只保留项目摘要、列表、`activeProjectId`、revision 与项目 API/命令。`ProjectListPage` 的保存 flush 由 app 注入，project feature 不再导入 canvas。
- 项目写互斥归属：`save-mutex` 不迁入 canvas。项目改名/封面与画布内容保存共用同一条写通道，互斥原语归 `entities/project`，以 `runProjectWrite<T>(fn: () => Promise<T>): Promise<T>` 暴露；`entities/project` 的项目命令与 canvas `save-manager` 都只使用这一实例，禁止第二个互斥锁。`features/project/store.ts` 不再直接持有互斥实现。
- 画布能力出口纠正：`features/canvas/upload` 的原始上传能力下沉 `entities/asset`，公共契约为批量 `uploadMany(items, options)`（并发/重试/限制/进度/错误分类，无画布副作用）与单文件包装 `uploadOne`；canvas `runMediaUpload` 删除 `{ kind: "raw" }` sink，只保留占位节点/替换/派生节点等画布语义，批量拆分与超限判定复用到 `lib/utils/upload`，禁止两份底层上传实现。`expandAccept` 迁入 `lib/upload-formats`。`createImageNodeFromRef` 等画布命令留在 canvas，并通过 page 级 `useDirectorBridge` 注入导演台。`features/auth` / `features/director` / `features/assets` 不再导入 canvas 内部。
- 共享能力下沉：`features/media` 整体迁到 `components/media`（或等价的 shared UI 目录），作为无业务状态的共享媒体渲染层；canvas 的 `VideoPlayer`、`media-playback`、`useAudioWaveformInstance` 与通用 `AudioWaveform` 一并下沉，`AudioWaveform` 的画布播放注册表/截取锁/`nodrag` 通过 `registerPlayer` / `controlsLocked` / `interactionClassName` 由 canvas 适配层注入，`audio-playback-registry` 仍留 canvas。`features/model` 的 `ModelSelector` / `ModelParamFields` / `ModelIcon` / `param-fields` 迁到 `components/model`，作为无状态模型 UI；资产/画布共用的悬浮预览泛化为 `components/media/MediaHoverPreview`（props 为 `{ name; mediaType; fileKey?; plainText?; enabled?; children }`），`features/assets` 的 `AssetHoverPreview` 删除，资产卡片与 canvas Explorer 资产视图都改用该组件；`MediaType` 从 `features/assets/types.ts` 上移到 `src/types/media.ts`（shared），shared 不反向导入 feature/entity 类型。
- app 组合根：页面、`providers`、`components/layout` 只从 feature/entity 公共 API 装配；页面壳与跨 feature 浮层由 app 持有；画布加载门 `CanvasLoader` 归 `components/layout`。
- 边界执行：扩展 `web/eslint.config.mjs` 的 `boundaries` 元素/策略，新增模块边界架构测试与存量基线。
- 首个试点：`specs/canvas-root-decomposition.md` 定义的 canvas 页面、`CanvasRoot`、`CanvasExplorer`、`ProjectToolbar` 及其依赖。
- 确认后同步更新 `web/AGENTS.md` 的“前端分层与组件边界规范”，避免文档与代码规则分叉。

## 非目标

- 不一次性重写所有 feature，不引入 monorepo、Nx、独立 npm 包或构建编排。
- 不引入事件总线、依赖注入容器、全局 service locator 或 `window` 自定义事件来做跨模块通信。
- 不更换 Next.js、React、React Flow、状态管理库或测试框架。
- 不修改后端分层；后端对应 `specs/server-crud-service-boundary.md`，`services` 是 use-case 契约层，不引入 entities 层。
- 不为了目录形式统一而重命名所有 feature 内部结构；保留 `stores / hooks / components / services` 等现有内部组织。
- 不为了减少跨 feature 依赖而把业务 UI 塞进 `components/ui`；共享 UI 只承载无业务语义的通用能力。
- 不为存量违规保留运行时兼容层；迁移必须替换调用方并删除旧出口。

## 分层与依赖

前端分层原则、依赖矩阵、模块契约、状态归属与跨 feature 注入规则统一由 [`web/AGENTS.md`](../web/AGENTS.md) 第八章维护（八.1 分层原则、八.2 模块契约、八.3 状态归属与跨 feature 注入）。本 Spec 不复制通用规则；以下只保留本能力域的模块归属与业务契约。

## 模块归属（初始目标）

| 模块 | 目标归属 | 职责与契约 |
| --- | --- | --- |
| `entities/asset` | entity | 资产/文件夹类型（`AssetItem` / `AssetFolder` / `AssetType` / `AssetScope` / `CreateAssetInput` / `AddAssetsBatchResult` / `RawUploadItem` / `AssetUpdatePatch` / `AssetBatchUpdate`；`MediaType` 归 shared `src/types/media.ts`，entity 不重复定义也不转发）、读取 Hook（存量 `useAssetLibrary({ enabled, scope, folderId, search, categories })` 原样迁入；服务端写入后的本地同步只经领域命令 `removeItems(ids)` / `patchItems(ids, patch)`，`patch` 仅含 `name` / `tags` / `prompt` / `type` 展示字段、只补丁当前查询窗口并丢弃切换查询后的过期写入，不对外暴露原始 setter；新增薄 selector `useAssetFolders(): AssetFolder[]`、`useAssetsInitialized(): boolean`、`getAssetsInitialized(): boolean`、`useKnownAssetKeys(): Set<string>`、`useAssetLibraryVersion(): number`（资产成员每次增删改后递增，含删除文件夹连带删除子树资产））、资产/文件夹命令（`initialize(): Promise<void>`、`addAsset(input: CreateAssetInput): Promise<AssetItem | null>`、`addAssetsBatch`、`updateAsset(id, patch: AssetUpdatePatch)`、`updateAssetsBatch(ids, updates: AssetBatchUpdate)`、`removeAssetsBatch`、`addFolder` / `removeFolder` / `renameFolder`、按 `fileKey` 取消收藏 `unsaveAssetsByFileKeys`）、原始批量上传 `uploadMany(items, options): Promise<RawUploadSummary>` 与单文件包装 `uploadOne`、常量 `ASSET_DRAG_TYPE` / `ASSET_NAME_MAX_LENGTH`；上传只做“Blob → 远程引用”，不导入 canvas、不写节点/历史/上传进度 store；不导出 `useAssetsStore`、`assetApi`、DTO。`createAssetNode` 依赖 canvas 节点工厂与类型，留在 canvas，资产 feature 不再转发。`getUncategorizedFolder`、`computeRecursiveFolderCounts`、`selectChildFolders` 只被 assets feature 内部消费，是 `features/assets` 的纯函数/selector，不强行上移 entity；canvas 不直接调用它们，只消费注入的 `AssetBrowserPanel`。UI 留在 `features/assets` |
| `entities/project` | entity | 类型 `ProjectSummary`；读取 `useProjects`、`useActiveProjectId`、`useActiveProjectSummary`、`getProjectRevision(id): number \| null`（列表无此项目时返回 `null`）；命令 `refreshProjects`、`createProject(name?: string): Promise<ProjectSummary \| null>`（默认名 `Project ${当前列表长度 + 1}`，成功后写入 `activeProjectId` 并返回摘要；失败经 store 统一提示并返回 `null`）、`renameProject`、`updateCover`、`deleteProject`、`activateProject`、`updateProjectRevision`、`upsertProjectSummary`；纯投影 `toProjectSummary(source)`（服务端列表 / 创建详情 / 画布会话详情共用的唯一摘要实现）；写互斥原语 `runProjectWrite<T>(fn)`（只覆盖携带 revision / 租约的写：画布保存、改名、封面；创建/删除不经过互斥，删除前须先 flush 画布保存）；项目元数据 API 只在内部使用，不导出 canvas 文档类型或保存编排 |
| `entities/director` | entity | 可序列化导演场景类型 `Shot`、`SceneState`（含嵌套场景字段）、`DirectorEntityMeta`（`{ id; type; name; visible; _members? }`，纯展示元数据、不含 Three.js）、`DirectorEntityState`、`DirectorStateData`、`DirectorImageNodeInput` 及纯不变量；只有 `DirectorEntity`（`Character \| Prop \| CameraEntity \| Crowd`，引用 Three.js 运行态类）留在 `features/director/types.ts`；Overlay、Inspector、store、3D runtime 与 UI 留在 `features/director` |
| `entities/user` | entity | 类型 `UserInfo` / `StorageSummary` / `ProfilePatch`；读取 `useCurrentUser()`（store + SSR 缓存合并）、`useSessionUser()`（仅 store）、`useUserStorage()`；命令 `initializeSession(): Promise<UserInfo \| null>`、`refreshStorage`、`login`、`register`、`logout`、`savePreference(key: "theme" \| "language", value: string)`、`updateProfile(patch: ProfilePatch)`；SSR 契约 `USER_COOKIE`、`parseUserCookie`、无视觉 `CachedUserProvider`（由 app 挂载）；不导出 `useAuthStore`。登录页、用户菜单、账号设置 UI 留在 `features/auth` |
| `entities/task` | 待盘点 | 只有被多个 feature 共享的任务状态才独立成 entity；仅 canvas 消费时留在 canvas |
| `features/canvas` | feature | 画布文档类型、节点图、交互、节点组件、浮层、Agent、编辑会话、保存编排与 session-expired；公共 API 导出页面级契约：`CanvasRoot`、`useCanvasSession(projectId): "connecting" \| "ready" \| "missing" \| "error"`（存量实现从 `features/project` 迁入）、新增 `useSessionExpired(): boolean`、`preloadCanvasPromptTemplates(queryClient): Promise<boolean>`（返回“当前存在可用提示词目录”：刷新成功，或刷新失败但 `queryClient` 已有缓存数据；仅无可用数据时返回 `false`）、`useDirectorBridge`、`flushCanvasSave(): Promise<void>` 与公开类型（`CanvasPorts` / `CanvasRootProps` / `CanvasSlots` / `DirectorBridge` / `CanvasSessionStatus`）；保存通过 `entities/project.runProjectWrite` 串行化 |
| `features/assets` | feature | 资产库 UI、上传/创建/选择流程；上传走 `entities/asset` 的 `uploadMany` / `uploadOne`，媒体预览走 `components/media`；不导入 canvas |
| `features/auth` | feature | 登录、用户菜单、账号设置 UI；消费 `entities/user` 与 `entities/asset` 上传命令；不导入 canvas |
| `features/project` | feature | 项目列表/创建/重命名/删除 UI；消费 `entities/project`（项目摘要与命令）、`entities/asset`（`uploadMany` 封面上传）与 `entities/user`（`useCurrentUser` / `logout` / `savePreference`）；`ProjectListPage` 通过 app 注入的 `flushPendingCanvasSaves: () => Promise<void>` 等待画布保存，并通过 `accountMenu: ComponentType<UserMenuProps>` / `accountSettings: ComponentType<AccountSettingsProps>` 注入账户菜单与账号设置弹窗（两个类型定义在 shared `src/types/user-menu.ts`）；不导入 canvas |
| `features/settings` | feature | API/模型设置 UI；消费 `components/model` 与 `lib/model-store`（存量模型库状态）；不导入 canvas store |
| `features/director` | feature | 导演 Overlay/Inspector/场景面板与 3D runtime；消费 `entities/director` 的可序列化类型；通过公开 props / page 级 `useDirectorBridge` 使用画布命令，不导入 canvas |
| `components/media` | shared | 由 `features/media` 与 canvas 的 `VideoPlayer` / `AudioWaveform` / `media-playback` / `useAudioWaveformInstance` 下沉组成的媒体渲染层，含通用媒体悬浮解析 `ResolvedHoverMedia` 与资产/画布共用的 `MediaHoverPreview`（入参只含展示数据，不含资产类型）；`AudioWaveform` 的播放注册/截取锁/`nodrag` 只经可选 props 注入，shared 不感知画布；不依赖任何 feature/entity，`MediaType` 读 shared `src/types/media.ts` |
| `components/model` | shared | 由 `features/model` 下沉的 `ModelSelector` / `ModelParamFields` / `ModelIcon` / `param-fields` 纯 UI 与纯函数；不依赖 feature/entity。模型库状态仍在 `lib/model-store`（存量例外） |
| `components/ui/theme-mode` | shared | 主题模式 Context：app 组合根挂载 `ThemeModeProvider`，业务层用 `useThemeMode()` 读取明暗模式（画布据此设置 React Flow `colorMode`）；用户设置来源仍在 `entities/user`，shared 不反向依赖 feature/entity，也不持有设置状态 |
| `components/layout` | app | 页面壳布局与画布加载门 `CanvasLoader`；不导入 feature 内部 |

`features/media` 与 `features/model` 不表达用户能力、也不持有自身状态，明确下沉为 shared；其它历史命名是否继续作为 feature，按“是否表达用户能力”判断，在各自迁移 Spec 中按同一标准处理，不在本 Spec 一次性改名。

## 关键契约

### 规则 1：项目写互斥与项目 API 拆分

`features/project/save-mutex.ts` 的互斥原语迁入 `entities/project`，公共契约为：

```ts
export function runProjectWrite<T>(fn: () => Promise<T>): Promise<T>;
```

- 全局单实例、FIFO；同一时刻只允许一个项目域服务端写请求。项目改名/封面命令与 canvas `save-manager` 的保存都调用它，不得各自创建互斥锁。
- 互斥范围只包网络写请求，不包 UI 乐观更新、历史压栈、画布快照生成；长任务不得进入临界区。
- 现状语义必须保留：元数据写不参与 revision 门禁、不递增 revision；同页并发写被串行化，因此 409 只可能来自跨页/租约失效。
- 互斥边界只覆盖携带 `revision` / 租约的项目写：画布保存、项目改名、封面。`createProject` / `deleteProject` 不经过 `runProjectWrite`——创建产生新的项目身份，不与既有项目的 revision 交互；删除的现有调用点（画布页与项目列表页）都在删除前先 `await flushCanvasSave()`，删除时不可能有保存在飞。后续调用方若绕过该前置条件，在途或迟到保存会收到 404 并进入失败重试，不会被误判为会话过期（409 语义专属于租约失效）。

`projectApi` 按职责拆开，禁止在 entity 与 canvas 各留一份：

- `entities/project` 内部使用 `listProjects` / `createProject` / `updateProject` / `deleteProject` 元数据接口，不导出 API 对象。
- canvas 持久化层使用 `saveProjectRaw` / `saveProjectDeltaRaw`（含 keepalive 语义），不得重新实现保存协议。
- `entities/project.createProject(name?: string): Promise<ProjectSummary | null>`：省略名称时使用 `Project ${当前列表长度 + 1}`（沿用现有默认命名），成功后写入 `activeProjectId` 并返回摘要；请求失败或接口未返回数据时由 store 统一提示并返回 `null`，不向调用方抛错，调用方收到 `null` 不得导航。会话已切换时丢弃迟到响应，不提示也不写列表。不接收、不返回画布内容。服务端以空 `canvasData` 创建，读取端 `restoreFromProject` 对缺失字段使用既有默认值；不新增/修改任何持久化字段。
- `getProjectRevision(id): number | null` 是同步只读 selector：列表无此项目时返回 `null`，由 canvas `save-manager` 折算为初始 revision `1`（与现状 `?? 1` 等价）；禁止把 `null` 写进保存请求。
- `activateProject(projectId)` 只写内存会话标记，不请求、不持久化；项目身份的唯一真相源仍是 URL。

### 规则 2：画布文档与保存的静态分层

现状 `features/canvas/stores/canvas-store.ts` 同时承担文档状态、写入动作与保存调度，`save-manager` 又需要读取文档，形成文件级运行时环。`CanvasSaveSource` 注册表只是把该环从静态依赖搬到了运行期服务定位，并引入注册时机约束。画布保存必须按以下静态无环结构组织：

```ts
// features/canvas/stores/canvas-document-store.ts（叶子：文档状态 + 纯写入 + 保存意图）
export const canvasDocumentStore: StoreApi<CanvasState>;
export function getCanvasProjectId(): string | null;
export function takeCanvasSnapshot(): HistorySnapshot;
export function getCanvasAgentModel(): string | undefined;

// features/canvas/persistence/save-intent.ts（叶子：有界保存意图）
export type CanvasSaveIntent =
  | { kind: "debounced" }
  | { kind: "immediate" }
  | { kind: "undo" }
  | { kind: "project-restored"; clearExpired: boolean };
```

- 依赖方向固定为 `save-manager → canvas-document-store`：保存器直接读取内容所有者、快照与 `agentModel`，并订阅 `save-intent`；文档 store 不导入保存器，只发出意图。`canvas-store` 是 React 适配层，经 `useStore(canvasDocumentStore, selector)` 保持既有 `useCanvasStore` 调用面（hook 选择器与 `getState` / `setState` / `subscribe` 不变），仅 `flushAndWait` 依赖保存器；不存在 `save-manager → canvas-store` 反向导入。
- `canvas-document-store` 只允许被 `canvas-store`（React 适配/命令面）与 `save-manager`（读取 + 意图订阅）导入；其他画布内部代码一律经 `canvas-store` 访问。该不变量保证保存器在任一动作可达前已完成订阅，由架构测试锁定。
- 删除 `canvas-save-source.ts` / `canvas-save-registration.ts` 与 `features/canvas/index.ts` 的副作用导入。不存在注册表、注册时机、未注册抛错或空快照兜底。意图订阅在 `save-manager` 模块求值时建立；保存器是意图的唯一订阅者，不依赖任何组件生命周期。
- `restoreFromProject` 在切换内容所有者前发出 `project-restored` 意图，保存器据此清理未派发编辑与基线；`clearExpired` 语义保持现行为（仅真正项目切换清除过期态，同项目/首次加载保留）。
- 保存器的其余协作者按层归属：`getCanvasLease` / `useSessionExpiredStore` 随会话迁入 canvas；revision 读取走 `entities/project.getProjectRevision`；写互斥走 `entities/project.runProjectWrite`；`projectApi.saveProjectRaw` / `saveProjectDeltaRaw` 是 canvas 内部保存传输。
- 架构测试按文件级 import 图判定无环，`import type` 边同样计入；不得以运行期注册、模块级可替换槽位或动态导入规避静态依赖。

### 规则 3：`adoptProject` 拆分

SSE 握手的采纳顺序固定为：

1. canvas 用自有解析器把 `data.project` 校验并映射为 `CanvasProject`（非法载荷直接返回 `rejected`，不写任何状态）。
2. 调用 `entities/project.upsertProjectSummary(summary)` 写项目摘要（列表可能为空，顶栏名称与 revision 依赖此摘要）。
3. 调用 canvas `restoreFromProject(projectId, project)` 恢复画布内容、建立保存基线、持有租约、清空撤销历史。

`entities/project` 不接触 `nodes` / `edges` / `viewport`，也不做画布文档校验；canvas 不直接写 entity store。两步之间不得插入 `await`，避免摘要已更新而内容未恢复的半状态。

### 规则 4：`entities/user` 状态与生命周期

- `useCurrentUser()` 保留 stale-while-revalidate：`initialized` 前返回 `store.user ?? cachedUser`，之后返回 `store.user`；`useSessionUser()` 只返回 store 值，供“是否已登录”类副作用使用。
- `CachedUserProvider` 由根布局注入；`USER_COOKIE` 与 `parseUserCookie` 是 SSR 契约，必须可在 Server Component 使用，不得带 `"use client"`。
- `initializeSession` 保留并发去重与会话切换失效语义，返回初始化完成后的用户（无用户返回 `null`）；`logout` 保留超时放行与本地清态；`savePreference` 保留失败回滚、语言同步与存储摘要刷新。
- `entities/user` 不导出 `useAuthStore`；`features/auth` 的页面/菜单/设置 UI 只通过上述公共 API 读写。

### 规则 5：`entities/director` 类型边界

- 只迁可序列化状态：`Shot`、`SceneState`、`DirectorEntityMeta`、`DirectorEntityState`、`DirectorStateData`（`sceneState` 仍是 `Partial<SceneState>`）；它们不得引用 Three.js 或 feature 内部。`DirectorEntityMeta`（`{ id; type; name; visible; _members? }`）是纯展示元数据，director store 的运行时列表直接使用它，必须与可序列化状态同层。
- `DirectorEntity`（`Character | Prop | CameraEntity | Crowd`）的成员类持有 Three.js 运行态，留在 `features/director/types.ts`；`DirectorNodeData` 是画布节点 data，留在 `features/canvas/types.ts`；`DirectorEntityState` / `DirectorStateData` 现定义在 `features/canvas/types.ts`，随本 Spec 迁入 `entities/director`。
- `entities/director` 只提供类型与纯函数/不变量；3D runtime、store、UI 状态留在 `features/director`。

### 规则 6：`entities/asset` 原始上传契约

```ts
export interface RawUploadItem {
  blob: Blob;
  filename: string;
}

// 模块内部类型：只作为 RawUploadSummary 的结构成分，不经 entity 公共入口导出
interface RawUploadOutcome {
  result: UploadResult | null;
  error: UploadErrorInfo | null;
}

export interface RawUploadSummary {
  outcomes: RawUploadOutcome[]; // 长度与顺序和入参 items 一致
}

export function uploadMany(
  items: readonly RawUploadItem[],
  options?: {
    source?: "upload" | "derived";
    onProgress?: (index: number, progress: UploadProgressValue) => void;
  },
): Promise<RawUploadSummary>;

export function uploadOne(
  blob: Blob,
  filename: string,
  source?: "upload" | "derived",
  options?: { notify?: boolean },
): Promise<UploadResult | null>;
```

**规则 6.1：上传职责（Blob → 远程引用）**：`uploadMany` 只负责“Blob → 远程引用”：复用 `lib/utils/upload` 的会话取消、重试、错误分类与 `lib/upload-formats` 的类型/大小限制；批次拆分与超限判定抽成 `lib/utils/upload` 的通用函数，由 entity 原始上传与 canvas 节点上传共用，禁止两份底层实现。
**规则 6.2：逐项结果与错误分类**：始终 resolve `RawUploadSummary`，单文件失败不 reject；不支持的类型、离线、超限在对应 outcome 内返回错误且不发请求；`UploadErrorCategory` 显式增加 `offline` / `unsupported`（均不可重试）。错误分类与重试边界遵循 [asset-batch-upload.md](asset-batch-upload.md) 规则 4「重试边界」：离线 / 不支持分别进入 `offline` / `unsupported`，超限沿用服务端同款业务错误进入 `business`；前置校验失败不得落为可重试的 network / unknown。`onProgress` 的 `index` 是原始入参下标。
**规则 6.3：无画布副作用与 `uploadOne` 包装**：无画布副作用：不得导入 canvas，不得写节点、撤销历史、上传进度 store 或占位节点；默认不弹全局提示。`uploadOne` 必须是 `uploadMany` 的单文件包装，只增加显式 `notify`，不复制格式校验、批次、重试或传输逻辑；`notify: true` 时经共享 `lib/global-message` 的 `showGlobalMessage` 保留现有全局失败提示，entity 不导入 feature UI。每个 outcome 的 `result` 与 `error` 恰有一个非空。
**规则 6.4：调用方前置校验**：`AssetCreateDialog` 可以保留基于共享 `kindOfBlob` / `isOffline` 的前置 UX 检查，以维持现有提示时机；`uploadMany` 仍必须独立执行同一校验并返回 `unsupported` / `offline` outcome，不能依赖调用方预过滤。
**规则 6.5：canvas 上传出口**：`features/canvas/upload` 的 `UploadSink` 删除 `{ kind: "raw" }`，`runMediaUpload` 只处理节点/替换/派生节点；canvas 上传 barrel 不再导出 `uploadOne`。资产库、头像、导演台等原始上传调用方统一改用 `entities/asset`。
**规则 6.6：`expandAccept` 归属**：`expandAccept` 迁入 `lib/upload-formats`；canvas `pick-files` 与资产库都从该处导入，不得在 feature 内保留副本。

### 规则 7：共享媒体组件边界

- `components/media` 承接 `VideoPlayer`、`AudioWaveform`、`media-playback` 与 `useAudioWaveformInstance`；这些组件/模块不得导入 canvas、任何 feature 或 entity。
- `components/media/MediaHoverPreview` 承接原 `features/assets/AssetHoverPreview`：props 为 `{ name: string; mediaType: MediaType | "text"; fileKey?: string; plainText?: string; enabled?: boolean; children: ReactElement }`，只负责 HoverCard 组装与浮层解析，不感知资产语义；`MediaType`（`"image" | "video" | "audio" | ""`）定义在 `src/types/media.ts`，assets 与 canvas 都从 shared 导入。`features/assets` 删除 `AssetHoverPreview` 文件，资产卡片与 canvas `CanvasExplorer` 资产行统一使用该组件。
- 共享 `AudioWaveform` 的公开 props 至少为：`audioRef`、`duration?`、`onReady?`、`registerPlayer?(handle: AudioPlayerHandle): () => void`、`controlsLocked?`、`interactionClassName?`。`AudioPlayerHandle` 为 `{ getCurrentTime(): number; pause(): void }` 的结构类型，shared 不引用 canvas 的播放注册表。
- 共享 `AudioWaveform` 不导入 canvas `clip-range`；带有限值保护的 `clamp01` 下沉 `lib/utils/number`，canvas `clip-range` 与 shared 共用同一实现。
- `controlsLocked` 同时锁住播放按钮与进度拖动；`interactionClassName` 应用到进度光标与播放按钮两处；`registerPlayer` 的 effect cleanup 必须注销注册。
- canvas `AudioNode` 传入稳定的 `registerPlayer` 回调，把 handle 注册到 `features/canvas/shared/audio-playback-registry`，并以 `controlsLocked={clipActive}`、`interactionClassName="nodrag"` 保留截取锁与拖拽语义；`audio-playback-registry` 与截取业务仍留 canvas。
- `AudioClipStripPanel` 使用共享的 `useAudioWaveformInstance` / `media-playback`；`AudioRefCard`、`VideoNode`、`MediaPreviewOverlay` 改用共享的 `media-playback` / `VideoPlayer`；不得保留 canvas 版副本或旧路径转发。
- `AssetInspector` 直接使用 `components/media` 的 `VideoPlayer` / `AudioWaveform`，不经过 canvas；相关测试随组件迁移并更新 mock 路径。

### 规则 8：ports / slots 稳定性

- `CanvasPorts` / `CanvasSlots` 的必填性、稳定引用、禁止可选链兜底与公共契约测试范围统一遵循 [`web/AGENTS.md`](../web/AGENTS.md) 八.3 第 5、6 条；本 Spec 不复制通用正文。
- canvas 特有约束：上述稳定引用是 canvas 位置帧重渲染 bail 的前提。
- 唯一例外是 `slots.assetsDialog`：page 侧的打开闭包持有 `assetsOpen`，开关变化时渲染函数引用必然变化。因此 `CanvasRoot` 不得把该 slot 传给 `CanvasSurface`、也不得把它写入任何 effect 依赖；slot 收到的 api 对象本身须 `useMemo` 稳定。`slots.assetsDialog` 的挂载位置因此只依赖 `ports`/`slots` 中的稳定成员。

### 规则 9：派生节点工厂与提交出口

- 三个 `*FromRef` 工厂（`createImageNodeFromRef` / `createAudioNodeFromRef` / `createVideoNodeFromRef`）只接收单一参数对象 `CreateDerivedNodeParams`（`sourceId` / `ref` / `labelSuffix` / `storeApi` / `extraNodeData?` / `positionOverride?` / `labelOverride?` / `options?`）；视觉工厂追加必填 `naturalWidth` / `naturalHeight`（`CreateVisualNodeParams`）。禁止位置参数，禁止按工厂分化的入参类型。
- `options.write === false` 只构建节点、不写 store；缺省写入节点并连线。多节点同批落库时由调用方以 `write: false` 构建后调用 `commitDerivedNodes(sourceId, nodes, storeApi)`；节点与连线在同一 `withHistoryBatch` 内写入，撤销语义见 [canvas-undo-redo-integrity.md](canvas-undo-redo-integrity.md) 规则 4（离散操作必定压栈 + 原子批量合并）。
- 单节点默认路径与批量提交共享同一写入实现（写入节点 + 到源节点的连线）；不得另建只写节点、只写连线或按工厂分化的写入旁路。

## 迁移策略

采用“契约先行、试点验证、基线收口”，不做大爆炸重写：

1. **基线**：加入 ESLint 元素/策略、架构测试与存量基线；跑通现有 web 测试，记录基线数量。此阶段不改变业务行为。
2. **共享层纠正**：`features/media` 整体迁到 `components/media`，并把 canvas 的 `VideoPlayer`、`media-playback`、`useAudioWaveformInstance` 与通用 `AudioWaveform` 一并下沉；`features/model` 的纯 UI 迁到 `components/model`，`AssetHoverPreview` 泛化为 `components/media/MediaHoverPreview` 并删除 assets 包装，`MediaType` 上移 `src/types/media.ts`；`expandAccept` 迁入 `lib/upload-formats`；`features/canvas/upload` 的 `uploadMany` / `uploadOne` 按“Blob → 远程引用”路径迁入 `entities/asset`，canvas 删除 raw sink 与旧导出并复用共享批次拆分；`providers/BatchConnectContext` 迁入 canvas。消除 shared/app 层对 feature 内部的依赖，以及 canvas 对其它 feature UI 的依赖。
3. **Entity 与画布文档归属**：先拆 `entities/project`（项目摘要/列表/`activeProjectId`/revision/项目命令/`runProjectWrite`）与 canvas（画布文档类型、`useCanvasSession`、`save-manager`、`canvas-lease`、`session-expired-store`）；`ProjectListPage` 的 flush 改为 app 注入。`adoptProject` 按“canvas 校验 → entity 摘要 upsert → canvas 恢复”拆分。再按 `asset → user → director` 迁移领域实现与公共 API；`director` 只迁可序列化类型，运行态实体类与 store 留在 feature。feature UI 改为消费 entity。每步更新调用方，不保留旧 store 导出。
4. **试点组合**：canvas 按 `specs/canvas-root-decomposition.md` 完成 app 页面组合、`CanvasRoot` 拆分、ports/slots 注入、`CanvasLoader` 上移与 director bridge；清零 canvas/entities 相关基线。
5. **收口**：删除旧 barrel 导出、深导入、`export *` 与死代码；收紧 lint；把 `web/AGENTS.md` 更新为最终规则。
6. **后续**：其它 feature 按同一规则逐个迁移，基线只能缩小；每次迁移单独 Spec/PR，不夹带无关重构。`features/project` 的账户菜单/`SettingsModal` 依赖 auth 等非 canvas 存量项，若未提前迁移则进入基线、由各自迁移删除（本次已提前改为 app 注入，见「当前状态」）；`features/settings/ApiSettingsModels` 随 `features/model` 下沉直接改依赖 `components/model`，`features/settings/ApiSettingsDrawer` 对 canvas store 的依赖在 canvas 试点中清除。

每一阶段必须保持 `cd web && npx tsc --noEmit`、`npm run lint`、`npx vitest run`（单 worker、串行）通过；根目录 Vitest 只收集 server 测试，web 测试必须在 `web/` 下执行。

## 技术影响

- 新增 `web/src/entities/*`、各 feature 的 `index.ts` 公共 API、`web/src/__tests__/architecture/module-boundaries.test.ts` 与基线文件。
- 调整 `web/eslint.config.mjs` 的 `boundaries/elements`、`boundaries/dependencies`、`check-file` 命名规则（如 app 组合目录需要新增 PascalCase 例外）。
- 移动 `features/media` 到 `components/media`，并把 canvas 的 `VideoPlayer`、`media-playback`、`useAudioWaveformInstance` 与通用 `AudioWaveform` 一并下沉；`features/model` 的纯 UI 到 `components/model`；`AssetHoverPreview` 泛化为 `components/media/MediaHoverPreview`（删除 assets 包装，`MediaType` 上移 shared）；`features/canvas/upload` 的 `uploadMany` / `uploadOne` 迁入 `entities/asset`，canvas 删除 raw sink 并复用共享批次拆分；`expandAccept` 迁入 `lib/upload-formats`；移动 `BatchConnectContext` 到 canvas。
- 拆分 `features/project`：项目摘要/列表/命令与 `runProjectWrite` 进 `entities/project`；画布文档类型、会话与保存编排进 `features/canvas`；`projectApi` 元数据接口留 entity、原始保存传输进 canvas；`ProjectListPage` 的 flush 改由 app 注入。
- 调整 director/auth/user：`Shot` / `SceneState` / `DirectorEntityMeta` / `DirectorStateData` / `DirectorEntityState` 进 `entities/director`，只有运行时联合 `DirectorEntity` 留 `features/director`；`DirectorOverlay` 改为公开 props + page 级 `useDirectorBridge`；头像上传改走 `entities/asset`；`entities/user` 承接 `UserInfo`、会话命令、SSR cookie 契约与 `useCurrentUser`，`useAuthStore` 不再对外导出。
- 调整 app 页面与 `providers`：页面壳上移、跨 feature 浮层由 app 持有、页面只从公共 API 装配；`CanvasLoader` 迁入 `components/layout`。`app/(app)/project/page.tsx` 的注入点必须是客户端组件（`"use client"`）或最小客户端桥，Server Component 不得向 Client Component 传函数 prop。
- `lib/utils/upload` 扩展 `UploadErrorCategory` 的 `offline` / `unsupported` 并抽出通用批次拆分函数；`lib/upload-formats` 承接 `expandAccept`；新增 `lib/utils/number` 承接 `clamp01`；canvas `UploadSink` 删除 raw 分支，相关测试 mock 与调用方同步迁移。
- 不新增运行时依赖；如边界测试需要新 devDependency，只允许作为 devDependency 并单独说明。
- 不改变后端接口、数据库、持久化格式与现有用户可见行为。

## 异常与边界

| 场景 | 行为 |
| --- | --- |
| 违反 [`web/AGENTS.md`](../web/AGENTS.md) 八.1 / 八.2 / 八.3 的通用边界规则（feature→feature、跨模块深导入、`export *`、entity 暴露视觉/store/setter、feature 内部状态被跨 feature 读取、app 深导入 feature、shared 反向依赖、循环依赖、port 传领域数据、事件总线/全局单例） | 按 [`web/AGENTS.md`](../web/AGENTS.md) 八.1 / 八.2 / 八.3 处理；本 Spec 只列本迁移特有的异常，不重复通用规则 |
| 画布文档类型、会话或保存编排留在 `features/project` | 视为所有权违规；迁入 `features/canvas`，project 只保留项目摘要/列表 |
| canvas 或 project feature 自建第二把项目写互斥锁 | 视为一致性违规；统一使用 `entities/project.runProjectWrite`，否则同页元数据写与画布保存重新并发 |
| `entities/project` 导出/重写画布保存传输，或 canvas 重写项目元数据 API | 视为契约重复；元数据 API 留 entity，原始保存传输留 canvas |
| `entities/user` 导出 `useAuthStore`，或调用方继续深导入 auth store | 视为契约泄漏；改用 entity 公共 Hook/命令 |
| `entities/director` 导入 Three.js 实体类或导出 store/UI | 视为层级违规；entity 只保留可序列化类型与纯不变量 |
| `features/project` / `features/director` / `features/auth` / `features/assets` / `features/settings` 导入 canvas 内部 | 视为边界违规；project 走 app 注入 flush，director 走公开 props / `useDirectorBridge`，auth/assets 原始上传走 `entities/asset`，资产预览走 `components/media`，settings 的 `settingsOpen` 归 page 并计入 `inputBlocked` |
| `features/assets` 继续使用 canvas `runMediaUpload` / `expandAccept` / `VideoPlayer` / `AudioWaveform` | 视为边界违规；批量上传走 `entities/asset.uploadMany`，`expandAccept` 走 `lib/upload-formats`，预览走 `components/media` |
| canvas `UploadSink` 保留 raw sink，或 `entities/asset` 复制画布上传管道 | 视为重复实现；raw 批量上传只归 entity，canvas 只保留节点/替换/派生语义 |
| `components/media/AudioWaveform` 导入 canvas 播放注册表/截取锁/`clip-range`，或硬编码 `nodrag` | 视为反向依赖；播放注册、截取锁与 `nodrag` 通过 props 注入，`clamp01` 走 `lib/utils/number` |
| Server Component 把 `flushCanvasSave` 等函数 prop 传给 Client Component | 构建/运行错误；项目路由壳改为客户端组件或经最小客户端桥注入 |
| `save-manager` 与 `canvas-store` 互相导入（含 `import type`） | 视为循环依赖；保存器直接读取 `canvas-document-store` 并订阅保存意图，`canvas-store` 仅经保存器暴露 `flushAndWait` |
| 以 `CanvasSaveSource` 之类的运行期注册表、副作用导入或模块级可替换槽位连接文档 store 与保存器 | 视为服务定位与装配时机耦合；两类协作方必须通过静态无环 import 或叶子意图信号连接 |
| 存量基线新增条目 | CI 失败；不得用基线掩盖新违规 |
| 无法解析的 import specifier | 架构测试 fail closed；先修复解析，不得跳过 |
| 为通过测试保留旧导出/旧路径 | 视为未完成；删除旧实现并迁移调用方 |

## 验收标准

1. `boundaries` 元素/策略与架构测试生效；故意加入 feature→feature、深导入、`export *`、循环依赖样例时检查失败。
2. canvas 与 entities 相关范围内：无 feature→feature 导入、无深导入、无 `export *`、无循环；全局基线不增加。
3. 所有被 canvas 使用的跨模块数据只经 `entities/*` 公共 API；所有跨 feature UI 能力只经 app 注入的 slots/ports。
4. `features/canvas/index.ts` 只导出页面级 canvas 契约：`CanvasRoot`、公开 props 类型、`useCanvasSession`、`useSessionExpired`、`preloadCanvasPromptTemplates`、`useDirectorBridge`、`flushCanvasSave`，签名与“模块归属”表一致；不导出 store、内部 hook/组件。
5. `entities/*/index.ts` 只导出领域类型、读取 Hook/selector、命令与纯函数；不导出视觉组件/store/setter；无视觉基础设施由 app 挂载。
6. app 页面是唯一页面组合根；`CanvasRoot` 不导入 auth/assets/project/settings；`providers` 不导入 canvas 内部；页面通过 `components/layout/CanvasLoader` 与 canvas 公开 hook/函数装配加载门。
7. `specs/canvas-root-decomposition.md` 的验收标准全部通过，且其边界验收引用本 Spec。
8. 新增公共 API 契约测试：entity 命令/selector 的成功、失败、边界路径；feature 公共组件的公开 props 行为；不依赖内部快照。
9. `cd web && npx tsc --noEmit`、`npm run lint`、`npx vitest run`（单 worker、串行）通过。
10. 无新增 `any`、`eslint-disable`、兼容导出、旧路径转发或死代码。
11. 用户可见行为、接口契约、持久化数据与性能特征不变；canvas 试点按 canvas Spec 的性能基线验收。
12. 确认后 `web/AGENTS.md` 同步为最终规则；文档与 lint/测试规则一致。
13. `features/project` / `features/director` / `features/auth` / `features/settings` 不再导入 canvas 内部；`ProjectListPage` 的 flush、导演台画布命令、头像上传、API 设置开关分别走 app 注入、entity 契约或 page 的 `settingsOpen` / `inputBlocked`。
14. 画布文档类型、会话与保存编排只存在于 `features/canvas`；`entities/project` 不导入 canvas 类型，`features/project` 不持有画布文档状态。
15. `app/(app)/project/page.tsx` 是 `"use client"` 组合根或经最小客户端桥注入 `flushCanvasSave`；Server Component 不向 Client Component 传函数 prop。
16. 项目域只有一份写互斥：`entities/project.runProjectWrite` 为唯一实例；改名/封面与 canvas 保存都经它串行化；调用链中不存在第二个 `SaveMutex` 或等价队列。
17. `entities/project` 的 `createProject(name?)` 按当前列表长度生成默认名、成功后写入 `activeProjectId`，成功时只返回 `ProjectSummary`；失败时统一提示并返回 `null`，调用方不导航；`getProjectRevision` 缺项返回 `null`，save-manager 折算为初始 revision `1`；`projectApi` 元数据接口与 canvas 原始保存传输各只有一处实现；SSE 握手按“canvas 校验 → entity 摘要 upsert → canvas 恢复”执行，非法载荷不产生任何 entity/canvas 状态写入。
18. `entities/user` 公共 API 与“关键契约”一致，不导出 `useAuthStore`；根布局、`providers`、`features/auth`、`features/canvas`、`features/project` 均只经该 API 读写用户、存储摘要与偏好。
19. `entities/director` 不引用 Three.js/feature 运行态类型；`DirectorEntityMeta` 与可序列化状态在 entity，只有运行时联合 `DirectorEntity` 留在 `features/director`，`DirectorNodeData` 留在 canvas；可序列化状态类型只有 entity 一份定义。
20. `features/media` 与 `features/model` 不再存在；`components/media` / `components/model` 不导入任何 feature/entity；`components/media` 承接 `VideoPlayer` / `AudioWaveform` / `media-playback` / `useAudioWaveformInstance`，画布注册、截取锁与 `nodrag` 只经 props 注入，`clamp01` 来自 `lib/utils/number` 且只有一份实现；`MediaHoverPreview` 在 `components/media`，`features/assets` 不再有 `AssetHoverPreview`，`MediaType` 只有 `src/types/media.ts` 一份定义。
21. `CanvasPorts` / `CanvasSlots` 全部必填，page 提供稳定引用（`slots.assetsDialog` 的例外见规则 8（ports / slots 稳定性））；canvas 内部无可选链兜底；契约测试覆盖缺失类型错误、slot 参数与无关重渲染 bail。
22. `features/assets` 不导入任何 canvas 路径：`AssetCreateDialog` 使用 `entities/asset.uploadMany` 与 `lib/upload-formats.expandAccept`，`AssetInspector` 使用 `components/media`，`AssetsDialog` / `AssetBrowserPanel` 使用注入回调；资产批量上传无节点、历史或上传进度 store 副作用。资产拖入画布仍走 `AssetCard` 的 `draggable` + `entities/asset.ASSET_DRAG_TYPE`（`dataTransfer` 写 `AssetItem` JSON），canvas `use-file-drop` 从同一 entity 常量读取；`onInsertAsset` 只服务点击插入路径，不承担拖拽。
23. `entities/asset` 的 `uploadMany` / `uploadOne` 保持输入顺序与长度、批次限制、重试、取消、逐项进度；每项 outcome 的 `result` / `error` 恰有一个非空；离线/超限/不支持分别进入 `offline` / `business` / `unsupported`，不伪装成网络错误；`uploadOne` 是 `uploadMany` 的单文件包装，仅增加显式 `notify`（经共享 `showGlobalMessage`）；canvas `runMediaUpload` 不再含 raw sink，节点上传复用同一底层传输与批次拆分实现。
24. 保存依赖图为静态无环：`canvas-document-store` 是叶子，不导入保存器，且只被 `canvas-store` 与 `save-manager` 导入；`save-manager` 直接读取文档快照 / 所有者 / `agentModel` 并订阅 `save-intent`；`canvas-store` 是 React 适配层，仅 `flushAndWait` 依赖保存器；不存在 `CanvasSaveSource` 注册表、注册副作用导入、未注册抛错或空快照兜底；`restoreFromProject` 的 `project-restored` 意图先于内容所有者切换派发；`features/canvas` 文件级依赖图（含 `import type`）无环。
25. 符合规则 9（派生节点工厂与提交出口）：三工厂只接收参数对象，`options.write: false` 仅构建不写入，批量提交经 `commitDerivedNodes` 在同一 `withHistoryBatch` 内写入节点与连线；不存在位置参数、按工厂分化的入参类型或只写节点/只写连线的旁路。

## 已确认事项

2026-11-04 用户确认本 Spec 及以下全部事项（1–16）；原问句保留为决策记录。

1. **分层命名**：是否确认 `app → features → entities → shared`，`entities` 作为跨 feature 领域契约层；`shared` 复用现有 `components/ui`、`components/media`、`lib`、`types`，不新建 `src/shared`？
2. **共享层纠正**：是否确认把 `features/media` 整体下沉为 `components/media`，并把 canvas 的 `VideoPlayer` / `AudioWaveform` / `media-playback` / `useAudioWaveformInstance` 一并下沉、画布注册/截取锁/`nodrag` 通过 props 注入；把 `features/model` 的无状态 UI 下沉为 `components/model`，并作为 shared UI 层；`AssetHoverPreview` 泛化为 `components/media/MediaHoverPreview` 并删除 assets 包装，`MediaType` 上移 `src/types/media.ts`；模型库状态仍留在 `lib/model-store`？
3. **Entity 边界**：是否确认本期先抽 `asset / project / director / user` 四个 entity；`entities/project` 只保留项目摘要/列表/`activeProjectId`/revision/项目命令/`runProjectWrite`，画布文档与会话/保存归 canvas；`entities/director` 只承接可序列化类型；`task` 暂不独立，等调用方盘点后再定？
4. **组合与注入**：是否确认页面壳（资产库、API 设置、快捷键、退出、删除项目、DirectorOverlay）由 app 页面持有；canvas 只保留 Explorer/Agent 等 canvas 自有浮层；`CanvasLoader` 归 `components/layout`；跨 feature UI 通过 `userMenu`、`assetBrowser`、`assetsDialog` 等 slots 和 `onOpenAssets`、`onOpenSettings`、`onOpenShortcuts`、`onOpenDirector(nodeId)` 等 ports 注入；页面通过 canvas 公开的 `useCanvasSession` / `useSessionExpired` / `preloadCanvasPromptTemplates` / `useDirectorBridge` / `flushCanvasSave` 装配？
5. **存量处理**：是否接受“存量基线 ratchet + canvas/entities 先清零”的渐进迁移，而不是一次性修复全站所有存量违规？
6. **边界工具**：是否接受 ESLint `boundaries` + TypeScript AST 架构测试的组合；若需要新增依赖，只作为 devDependency？
7. **迁移顺序**：是否确认先做共享层纠正与 entity 契约，再做 app 页面组合，最后拆 canvas 内部；VideoNode 拆分仍在本轮 canvas Spec 内？
8. **公共 API 清理**：是否确认 feature barrel 中的 store/内部组件/内部 hook 导出随 entity 迁移直接删除，不保留旧导出兼容？
9. **画布会话/保存归属**：是否确认把 `use-canvas-session`、`save-manager`、`canvas-lease`、`session-expired-store` 与画布文档类型从 `features/project` 迁入 `features/canvas`；`save-mutex` 以 `runProjectWrite` 留在 `entities/project` 供双方共用；`ProjectListPage` 的 flush 由 app 注入 `flushCanvasSave`，且项目路由壳作为客户端组件或客户端桥完成注入？
10. **导演台/上传边界**：是否确认 `DirectorOverlay` 改为公开 props + page 级 `useDirectorBridge`，`uploadMany` / `uploadOne` 下沉 `entities/asset`、canvas 删除 raw sink，`features/director` / `features/auth` / `features/assets` 不再导入 canvas；`DirectorEntityMeta` 与可序列化状态迁入 entity，只有运行时联合 `DirectorEntity` 留在 feature？
11. **项目 API 与采纳拆分**：是否确认 `projectApi` 元数据接口留在 `entities/project`、`saveProjectRaw` / `saveProjectDeltaRaw` 归 canvas；`createProject` 成功时只返回 `ProjectSummary`、失败时提示并返回 `null`；SSE 握手按“canvas 校验 → entity 摘要 upsert → canvas 恢复”拆分？
12. **用户契约**：是否确认 `entities/user` 按“关键契约”承接 `UserInfo`、会话命令、偏好命令、SSR cookie 契约与 `CachedUserProvider`，并删除 `useAuthStore` 对外导出？
13. **导演类型**：是否确认只迁 `Shot` / `SceneState` / `DirectorEntityMeta` / `DirectorEntityState` / `DirectorStateData` 到 `entities/director`，只有运行时联合 `DirectorEntity` 留在 feature？
14. **ports/slots**：是否确认全部必填、由 app 显式提供 no-op / `() => null`，并要求稳定引用与契约测试，而不是在 canvas 内部做可选链兜底？
15. **资产原始上传与共享音频**：是否确认 `entities/asset` 提供 `uploadMany` / `uploadOne` 原始上传契约并删除 canvas raw sink，`expandAccept` 迁入 `lib/upload-formats`，`components/media` 承接 `VideoPlayer` / `AudioWaveform` / `media-playback` / `useAudioWaveformInstance`，使 `features/assets` 不再导入 canvas？
16. **画布保存依赖倒置**：是否确认 `save-manager` 不再导入 canvas store，改由 `CanvasSaveSource` 在 `features/canvas` 模块初始化时注册（不依赖 `CanvasRoot` 挂载）读取内容所有者、画布快照与 `agentModel`，注册缺失即抛错？
    - 2026-11-09 已被规则 2（画布文档与保存的静态分层）取代：删除 `CanvasSaveSource` 注册表，改为 `canvas-document-store` 叶子 + 有界保存意图 + React 适配层；本条保留为决策历史，现行契约以规则 2 为准。

## 当前状态

- 2026-11-04：完成前端结构盘点与目标架构起草；本 Spec 为待确认，尚未修改任何业务代码。
- 2026-11-04：根据用户“按模块契约架构调整”的决策，明确 `app → features → entities → shared`、feature 隔离、entity 契约、app 组合与可执行边界；canvas 作为首个试点，具体落地见 `specs/canvas-root-decomposition.md`。
- 2026-11-04：一致性复核补入画布会话/保存从 `features/project` 迁入 canvas、`CanvasLoader` 上移 `components/layout`、导演台 `useDirectorBridge` 与上传下沉 `entities/asset`；`features/project` / `features/director` / `features/auth` 不再导入 canvas。
- 2026-11-04：补入项目路由的 Next.js 客户端边界：`flushCanvasSave` 只能由客户端组件或客户端桥注入，Server Component 不得传函数 prop。
- 2026-11-04 二次修订：修正 `save-mutex` 归属——项目改名/封面与画布保存共用 `entities/project.runProjectWrite`，不随 save-manager 迁入 canvas；补全 `entities/project` / `entities/asset` / `entities/user` / `entities/director` 的公共 API 与生命周期契约；明确 `AssetHoverPreview` 留在 assets（后由四次修订改判为泛化下沉），只下沉 `features/media` 与 `features/model`；拆分 `projectApi` 元数据/保存传输与 `adoptProject`；补充 ports/slots 必填、稳定引用与契约测试；新增验收 16–21 与待确认事项 11–14。
- 2026-11-04 三次修订：补齐 `features/assets` 的 canvas 反向依赖缺口——`entities/asset` 增加 `uploadMany` 原始批量上传契约，canvas 删除 raw sink；`expandAccept` 迁入 `lib/upload-formats`；`components/media` 承接 canvas `VideoPlayer` / `AudioWaveform` / `media-playback` / `useAudioWaveformInstance`；交叉核对同时明确 `features/settings` 不导入 canvas store、`uploadOne` 的 `notify` 经共享 `showGlobalMessage`、`clamp01` 下沉 `lib/utils/number` 与 `uploadMany` 逐项 outcome 契约；新增验收 22–23 与待确认事项 15。
- 2026-11-04 四次修订：依据审核结论修正——shared 分层与 ESLint 元素补入 `components/model`；`DirectorEntityMeta` 更正为纯展示元数据并迁入 `entities/director`；明确 `createProject(name?)` 默认命名/激活/返回摘要与 `getProjectRevision` 的 `null` 语义；补全 `features/canvas` 公共 API 签名；新增“画布保存依赖倒置”契约（`CanvasSaveSource`，文件级无环）；`AssetHoverPreview` 泛化为 `components/media/MediaHoverPreview` 并删除 assets 包装，`MediaType` 上移 `src/types/media.ts`；`entities/asset` 四个 selector 标注为新增并给出签名；新增验收 24 与待确认 16。
- 2026-11-04 五次修订：依据二次审核结论修正——`CanvasSaveSource` 注册改到 `features/canvas` 模块初始化（`CanvasRoot` 挂载晚于会话握手，不能作为注册点）；`slots.assetsDialog` 因 page 闭包持有 `assetsOpen` 列为稳定引用规则的唯一例外，并禁止传给 `CanvasSurface` 或进入 effect 依赖；`entities/asset` 明确 `addAsset(input): Promise<AssetItem | null>` 签名与文件夹纯函数留在 feature；`AssetBrowserPanel` 保留 `ASSET_DRAG_TYPE` 拖拽路径，`onInsertAsset` 只管点击；`preloadCanvasPromptTemplates` 明确“刷新失败但已有缓存仍为可用”。同步更新验收 22、24 与待确认 16。
- 2026-11-04 六次修订：依据审核结论修正——`canvas-save-source.ts` 落位统一为 `features/canvas/persistence/`，职责为数据源类型与注册/读取函数（不产生注册副作用）；模块顶层自注册由同目录 `canvas-save-registration.ts` 承担，并由 `features/canvas/index.ts` 副作用导入；待确认 16 的注册时机统一为“模块初始化，不依赖 `CanvasRoot` 挂载”。
- 2026-11-04 用户确认本 Spec（含上述十六项事项）；确认范围为业务规则、接口契约与技术方案，不含数据库变更、生产部署、提交或推送授权；状态改为「已确认」。尚未开始实现，未执行测试。
- 2026-11-04 试点实施完成（工作区未提交）：canvas 按本 Spec 与 `specs/canvas-root-decomposition.md` 完成页面组合、`CanvasRoot` 拆分、ports/slots 注入、`CanvasLoader` 上移与 director bridge；`module-boundaries.baseline.json` 中 canvas/entities 条目清零，仅余 2 条既有非 canvas 项（`features/project/components/ProjectListPage.tsx → @/components/layout/AppShell`、`features/settings/index.ts → @/lib/api/model-api`），无循环。实施中发现测试源导入 `@/__tests__/test-utils/*` 被误判为跨层依赖：根因修复为在边界测试中把共享测试脚手架归入 `test-support`，仅允许 `__tests__/**` 测试源依赖，生产文件仍禁止依赖；该语义调整需用户确认是否接受。验证结果见 `specs/canvas-root-decomposition.md` 当前状态。状态保持「已确认」，实现代码未提交。
- 2026-11-05 边界修复（工作区未提交）：按 `web/AGENTS.md` 八.1 的测试文件归属规则收紧测试文件归属，不再把所有 `__tests__/**` 统一归入 `test-support` 豁免——feature/entity 测试归所属模块，仅 `__tests__/test-utils/**` 与 `__tests__/setup.ts` 保留 `test-support`，其余测试按 app 组合层校验。组合层测试若直接导入 entity 内部 store 会被判 deep-import；相关测试已改为经公共命令/selector 与同一传输 seam（`@/lib/api/client`）驱动，并新增三类归属的负例覆盖。状态保持「已确认」，实现代码未提交。
- 2026-11-05 根因修复（工作区未提交）：`ProjectListPage` 的账户菜单/`SettingsModal` 已提前改为 app 注入（`accountMenu` / `accountSettings`），不再进入基线；该注入是模块契约下的最终形态，不是临时例外。同步删除 `resetCanvasSaveSource` 死导出、收回 `ProjectWritePatch` 导出、`writeContent` 改用 `ProjectRow` 显式返回类型；`uploadMany` 与画布上传管道统一改用 `lib/utils/upload` 的 `oversizeUploadErrorBody` 前置判定（单文件超限但未超批次上限时不再发请求，单文件上限优先于批次上限）；`updateProjectDelta` 补 `baseRevision` fail-closed 守卫；新增 `CanvasRoot` ports/slots 运行时与类型层契约测试（必填缺失、slot 参数、`assetsDialog` 引用变化不扩散重渲染）；`web/AGENTS.md` 同步为 `app → features → entities → shared` 最终规则。状态保持「已确认」，实现代码未提交。
- 2026-11-05 死代码与分层清理（工作区未提交）：`entities/asset` 公共入口不再导出无消费方的 `RawUploadOptions` / `RawUploadOutcome` / `AssetLibraryQuery` / `AssetLibraryState`（`RawUploadOutcome` 仍是 `upload.ts` 内部结构类型，只经 `RawUploadSummary["outcomes"]` 暴露）；`features/settings` 删除 `modelApi` 转发；`ProjectListPage` 不再包裹 `AppShell`，页面壳组合上移 `app/(app)/project/page.tsx`，`web/eslint.config.mjs` 补 `components/layout` 为 app 元素，`module-boundaries.baseline.json` 的违规与循环条目清零；canvas 专用 `OfflineIndicator` 从 `components/ui` 移入 `features/canvas/root/`；`AudioWaveform` 的公开句柄类型由 `AudioWaveformHandle` 更名为 `AudioPlayerHandle`。状态保持「已确认」，实现代码未提交。
- 2026-11-05 文档校正（工作区未提交）：`features/project` 模块表补入 app 注入的 `accountMenu` / `accountSettings` 与 `entities/asset` / `entities/user` 依赖；修正六次修订中 `canvas-save-source.ts` 的职责表述，与「画布保存依赖倒置」契约及验收 24 对齐——`canvas-save-source.ts` 只承载类型与注册/读取函数，模块顶层自注册由 `canvas-save-registration.ts` 承担。状态保持「已确认」，实现代码未提交。
- 2026-11-06 契约与死代码清理（工作区未提交）：`entities/asset` 删除无调用方的 `listFolders` / `listFileKeys` 传输方法（bootstrap 已返回 folders/fileKeys）；`removeFolder` 在删除子树资产后补发 `noteLibraryChanged()`，与其它资产增删改一致地递增 `libraryVersion`，并补充 store 回归测试；`components/model/ModelIcon` 收回无调用方的 `resolveModelIcon` 导出；`components/ui/theme-mode` 的 `ThemeMode` 类型收回为模块内部类型；架构测试明确“公共 API 不得转发其它模块”并加入外部包具名转发的负例。验证：`npx tsc --noEmit` 通过；`npm run lint` 0 error（6 个既有 `<img>` warning）；web `npx vitest run --maxWorkers=1` 203 文件 / 1624 测试通过。2026-11-06 浏览器走查（本地 dev 预览，已登录）：在现有文件夹内创建并删除临时子文件夹，确认 `DELETE /api/assets/folders/:id → 200` 后，仍打开的文件夹资产列表随即重新请求 `GET /api/assets/items?folder_id=5&scope=personal&limit=50`，文件夹卡片消失，无新增控制台错误；根目录视图按设计只展示文件夹、不请求资产列表，因此走查使用文件夹内视图。临时文件夹已删除，未改动既有资产。状态保持「已确认」，实现代码未提交。
- 2026-11-06 契约清理（工作区未提交）：`useAssetLibrary` 不再返回原始 React setter `setItems`，改为领域命令 `patchItems(ids, patch)`（`AssetItemPatch` 只允许 `name` / `tags` / `prompt` / `type` 展示字段），`AssetsDialog` 四处本地同步全部迁移，并补充“只补丁匹配项”与“切换查询后丢弃过期写入”回归测试；`features/canvas` 的 `CanvasSurfaceSlots` 收窄为 `Pick<CanvasSlots, "userMenu">`，无消费方的 `assetBrowser` 透传被删除，`CanvasRoot` 契约测试同步断言 `CanvasSurface` 不再收到 `assetBrowser` / `assetsDialog`；派生节点“节点 + 源连线”提交抽出 `commitDerivedNodes`，替换上传管道与视频编辑动作中的 5 处重复批次，并为节点/边同批写入补充单元测试；媒体音量钳制复用 `lib/utils/number.clamp01`；`use-canvas-panels` 的面板源引用取值抽出 `mediaSrcOf`。验证：`npx tsc --noEmit` 通过；`npm run lint` 0 error（6 个既有 `<img>` warning）；相关测试 4 文件 / 38 测试、架构与资产测试 4 文件 / 21 测试通过。状态保持「已确认」，实现代码未提交。
- 2026-11-06 互斥边界澄清（仅文档，代码未改动）：明确 `runProjectWrite` 的互斥范围只覆盖携带 `revision` / 租约的项目写——画布保存、项目改名、封面；`createProject` / `deleteProject` 不经过互斥，已确认事项 16 中的“项目元数据写”按此解释为改名/封面。删除的现有调用点（画布页 `handleDeleteProject` 与项目列表页）都在删除前 `await flushCanvasSave()`；绕过该前置条件时在途或迟到保存会收到 404 并进入失败重试，不会被误判为会话过期。状态保持「已确认」，实现代码未提交。
- 2026-11-07 共享契约与删除前置（工作区未提交）：`@noxrea/shared` 新增 `./object` 子路径（`isRecord` 普通对象守卫），server 的 `json-column` / `canvas-hashes` / `context-builder` 与 web 的 `api/error-message` / `api/client` / `model-store` / canvas 会话载荷共用，删除仅服务端使用的 `server/utils/is-record.ts`；补记此前已落地但未入表的 `shared/canvas-summary.ts`（首图提取，`server/utils/canvas-summary` 与 `features/canvas/session/project-payload` 共用）与 `shared/time.ts`（时间戳解析，`entities/asset` / `entities/project` / canvas 会话载荷共用）。`ProjectListPage` 删除确认在调用 `deleteProject` 前 `await flushPendingCanvasSaves()`，与画布页 `handleDeleteProject` 及本 Spec 2026-11-06「删除前由调用方 flush」一致，并补回归测试锁定「先 flush 再删除」时序。状态保持「已确认」，实现代码未提交。
- 2026-11-07 记录更正：2026-11-05 条目中的「收回 `ProjectWritePatch` 导出」已反转为导出。该类型是 `server/crud/canvas.ts` 中 `updateProjectRowTx` 的公开参数契约；隐藏类型名只会迫使 `services/canvas/project-write.ts` 重写形状。现导出并在 service 复用，服务端规则与验收见 [server-crud-service-boundary.md](server-crud-service-boundary.md) 规则 3（事务归属）与第 2 节「画布纯函数归位，写用例上移」。该条目原将服务端类型记入 Web Spec，特此更正归属。
- 2026-11-08 基础类型归属清理（工作区未提交）：`features/canvas/types.ts` 删除基础类型的兼容转出——`TaskBinding` / `UploadState` / `ViewportState` 的唯一定义与导入路径是 `@/lib/types/canvas`，`TaskStatus` 直接来自 `@noxrea/shared`；`lib/types/canvas.ts` 不再转出 `TaskStatus`。全部调用方（`generation-api`、`CanvasExplorer`、`use-node-generating`、`upload-pipeline`、`canvas-store`、`session/project-payload`）改为直接从归属模块导入，`isTerminalTaskStatus` 改用共享 `TASK_TERMINAL_STATUSES` 而非本地字面量。同步修正两处过期归属注释（`components/media/ResolvedHoverMedia` 的解析层归属、`features/auth/UserMenuPopover` 的 entity 依赖说明），并更正 `web/AGENTS.md` 中 `AudioWaveform` 的层级归属（共享媒体组合层，不是画布领域组件）。验证：`npm run typecheck`、`npm run lint`（0 error，6 个既有 `<img>` warning）通过；服务端 108 文件 / 1285 passed / 14 skipped，web 207 文件 / 1643 passed。状态保持「已确认」，实现代码未提交。
- 2026-11-08 上传契约规则编号（仅文档）：`entities/asset` 原始上传契约的六条要点补粗体标题并编号（当时为规则 1–6；五轮修订后调整为规则 6.1–6.6，见下方同日「五轮评审修复」），供 `specs/canvas-root-decomposition.md` 按 `AGENTS.md` 十二.3.4 精确引用；该 Spec 已删除重复正文，只保留「文件名 + 规则编号 + 规则标题」引用。规则语义未变。状态保持「已确认」。
- 2026-11-08 创建失败语义与参数收敛（工作区未提交）：`createProject` 改为 `Promise<ProjectSummary | null>`——请求异常或响应无数据时由 store 统一提示并返回 `null`，失败不写列表、不切 `activeProjectId`；画布页与项目列表页收到 `null` 不导航，会话切换丢弃迟到响应。派生节点 `createImageNodeFromRef` / `createAudioNodeFromRef` / `createVideoNodeFromRef` 改用参数对象（`CreateDerivedNodeParams` / `CreateVisualNodeParams`，`options` 统一收在基类型）收敛 8–10 项位置参数，全部生产与测试调用点同步迁移。验证：`npm run typecheck` 通过；`npm run lint` 0 error（6 个既有 `<img>` warning）；web 全量 209 文件 / 1663 用例通过；server 全量 108 文件 / 1286 用例通过（3 文件跳过、14 用例跳过）。状态保持「已确认」，实现代码未提交。
- 2026-11-08 二轮评审修复（工作区未提交）：`entities/asset` 的 `AssetBootstrapDto` 改为模块内部类型（与「不导出 DTO」契约一致，无调用方受影响）；storage-key 架构扫描器补充参数对象形式 `create*NodeFromRef({ ref })` 的 `ref` 属性检查并增加自检用例；`DirectorViewport` / `AvatarCropModal` 的 raw sink 过期注释更新为 `entities/asset.uploadOne` 统一上传出口；`web-managed-media-hydration.md` 状态行按实际授权顺序改写。验证：`storage-key-write-contract` 定向用例、`npm run typecheck`、`npm run lint` 通过。状态保持「已确认」，实现代码未提交。
- 2026-11-08 三轮评审修复（工作区未提交）：派生节点三工厂统一经 `finishDerivedNode` / `writeDerivedNode` 落库，单节点离散创建在 `withHistoryBatch` 内完成节点 + 连线写入，修复音频/视频默认路径在距上次压栈不足 300ms 时不产生独立撤销步的缺陷（[canvas-undo-redo-integrity.md](canvas-undo-redo-integrity.md) 规则 4）；图片工厂同步支持 `options.write=false`，三工厂 `options` 语义统一。新增 `derived-node-history.test.ts` 回归；`derived-node-commit` / `transform-baking` / `thumbnail-scaling` 通过。验证：web 全量 210 文件 / 1666 用例、typecheck、lint 0 error（6 个既有 `<img>` warning）通过。状态保持「已确认」，实现代码未提交。
- 2026-11-08 四轮评审修复（工作区未提交）：删除 `CreateNodeOptions` 中无调用方的 `connectToSource` / `skipHistory` 及 `applyDerivedWrite` 的对应分支，单节点与批量派生统一为「写入节点 + 连线」一条路径；`derived-node-history.test.ts` 扩展为图片 / 视频 / 音频三工厂逐项锁定。验证：web 全量 210 文件 / 1668 用例、typecheck、lint 0 error（6 个既有 `<img>` warning）通过。状态保持「已确认」，实现代码未提交。
- 2026-11-08 五轮评审修复（工作区未提交）：关键契约小节编号为规则 1–8（`entities/asset` 子规则 6.1–6.6），新增规则 9（派生节点工厂与提交出口）与验收 25，供其它 Spec 按 `AGENTS.md` 十二.3.4 精确引用；派生实现同步根因收口——删除 `CreateNodeOptions`，`options` 内联为 `{ write?: boolean }`，`writeDerivedNode` 复用 `commitDerivedNodes`，`spawnPromptDerivedNode` 复用 `resolveDerivedPosition`；`derived-node-history.test.ts` 增补批量守卫用例（两次写入跨过 300ms 节流窗口仍只产生一条撤销记录，临时移除守卫可复现失败）。验证：`npm run typecheck`、`npm run lint`（0 error，6 个既有 `<img>` warning）通过；web 全量 210 文件 / 1669 用例通过。状态保持「已确认」，实现代码未提交。
- 2026-11-09 六轮评审修复（工作区未提交）：删除与 `web/AGENTS.md` 第八章重复的分层、模块契约、状态归属与边界执行正文，改为引用唯一权威；规则 8 只保留 canvas 特有约束（`slots.assetsDialog` 与位置帧 bail），异常表将通用边界场景收敛为对八.1 / 八.2 / 八.3 的引用；修正过期规则编号与跨 Spec 引用格式。派生节点边写入改走新增的 `CanvasStoreApi.addEdges` 追加命令，`commitDerivedNodes` 不再读取调用方 `edges` 快照；`derived-node-history.test.ts` 固定「快照后追加的无关连线不被覆盖」，临时恢复旧 `setEdges` 快照实现可复现失败。验证：`npx tsc --noEmit`、`npm run lint`（0 error，6 个既有 `<img>` warning）通过；web 全量 210 文件 / 1670 用例通过。状态保持「已确认」，实现代码未提交。
- 2026-11-09 七轮评审修复（工作区未提交）：项目摘要投影收敛为 `entities/project` 的单一 `toProjectSummary(source)`——服务端列表 / 创建详情 / 画布会话详情三个调用方只归一入参，不再各自拼装摘要；`features/canvas` 删除本地 `toProjectSummary`，SSE 握手直接从 `entities/project` 取投影。验证：`npm run typecheck` 通过；`npm run lint` 0 error（6 个既有 `<img>` warning）；web 全量 210 文件 / 1670 passed；server 全量 108 文件 / 1286 passed / 14 skipped。状态保持「已确认」，实现代码未提交。
- 2026-11-09 保存架构根因修订（工作区未提交）：规则 2 由「`CanvasSaveSource` 运行期注册」改为「文档 store 叶子 + 有界保存意图 + React 适配层」的静态无环结构，删除 `canvas-save-source.ts` / `canvas-save-registration.ts` 与 `features/canvas/index.ts` 的副作用导入；`save-manager` 直接读取 `canvas-document-store` 并订阅 `save-intent`，`canvas-store` 保留既有 `useCanvasStore` 调用面。该调整经用户明确授权更改核心架构，按根因与成熟方案实施。实现完成并通过验证：`npm run typecheck`、`npm run lint`（0 error，6 个既有 `<img>` warning）、server 全量 109 文件 / 1287 passed / 14 skipped、web 全量 211 文件 / 1676 passed（含新增 `save-intent`、`canvas-save-layering` 与指标边界用例），web 架构边界测试确认文件级依赖图无环。浏览器运行时走查未执行（本机预览 attach 不可用，未另起第二套开发栈）。状态保持「已确认」，代码未提交；「已实现」待用户确认提交后设置。
- 2026-11-14 提交事实与 HEAD 收口复验：
  - 提交事实：本 Spec 的实现与文档已随 `a2f521c0`（2026-11-09 23:43，400 文件混合提交）提交；上方 2026-11-04 至 2026-11-09 各条中的「工作区未提交 / 代码未提交」均为提交前状态，不再代表当前状态。收口时 HEAD 为 `6f5a81cf`，工作区干净。后续变更补记：`c6dc9c6f` 将 `module-boundaries.test.ts` 的边界扫描扩展到类型位置 `import("...")` 与 `import = require()` 并补负例；`entities/asset` 新增公共类型 `AssetUpdatePatch` / `AssetBatchUpdate`，`updateAsset` / `updateAssetsBatch` 签名收紧（模块表已同步）。
  - HEAD 串行验证：`cd web && npx tsc --noEmit` 通过；`npm run lint` 0 error（6 个既有 `<img>` warning）；web Vitest 226 文件 / 1841 用例通过（单 worker、串行）；架构测试 9/9 通过（`module-boundaries.baseline.json` violations=[]、cycles=[]）；`npm run build` 通过。server 全量未在本轮重跑。
  - 浏览器走查（自动化，方法与数值详见 [canvas-root-decomposition.md](canvas-root-decomposition.md) 当前状态 2026-11-14 条）：页面壳开合 nodes/edges 身份变化 0、renderer 不重挂；拖动/框选/缩放无 longtask；自动保存 `PUT /api/canvas/projects/:id` 200；SPA 项目切换页面上下文不重建、旧 React Flow 实例脱离 DOM、返回后节点与视口恢复。
  - 验收 7 依赖 canvas Spec：其验收 12（用户手工走查）未确认，故本 Spec 暂不能标「已实现」，状态保持「已确认」。验收 8 剩余缺口：`preloadCanvasPromptTemplates`、`useDirectorBridge`、`flushCanvasSave`（公开包装）、`useSessionExpired` 的契约测试，`DirectorOverlay` / `AssetsDialog` / `AssetBrowserPanel` 公开 props 行为测试，以及 `getProjectRevision` 缺项→初始 revision 1 的直接用例仍缺；验收 9/11 已按 web 侧命令复验。
  - ESLint 与架构测试分工：`web/eslint.config.mjs` 仍允许 feature→feature，feature 同层隔离由 `module-boundaries.test.ts` 的 same-name 判定强制；`src/proxy.ts` 未登记为 ESLint 的 app 元素但被架构测试归入 app，当前无违规。若需要 lint 层也拦截 feature 隔离，需单独调整 ESLint 配置，不属于本次收口范围。
  - 保存能力权威边界：规则 2 继续管画布文档与保存的静态分层；保存相位、会话有效性通知与卸载提示门等运行期行为以 [canvas-save-status.md](canvas-save-status.md) 为准。
- 2026-11-14 测试缺口收口（工作区未提交；仅测试与 Spec 变更，业务代码未改）：上条验收 8 列出的缺口已补齐——新增 `__tests__/features/canvas/PublicApi.test.tsx`（`preloadCanvasPromptTemplates` 成功 / 无缓存失败 / 失败但有缓存三态、`useDirectorBridge` 快照读取与节点删除后 no-op、`useSessionExpired`、`flushCanvasSave` 委托唯一 SaveManager）；新增 `__tests__/features/assets/AssetsDialog.test.tsx` 与 `AssetBrowserPanel.test.tsx`（`onInsertAsset` / `onInsertAssets` 回调参数与成功提示、紧凑网格与拖拽标志透传）；新增 `__tests__/features/director/DirectorOverlay.test.tsx`（快照注入、关闭顺序 captureState → onSaveState → reset → onClose、无快照跳过回写、视角切换转发）；`entities/project/store.test.ts` 补 `getProjectRevision` 缺项 → `null`，`save-manager.test.ts` 补 revision 为 `null` 时以 `baseRevision 1` 提交。验证（已验证事实）：`npx tsc --noEmit`、`npm run lint`（0 error，6 个既有 `<img>` warning）通过；web Vitest 233 文件 / 1904 用例通过（单 worker、串行）；架构测试 5 文件 / 50 用例通过。验收 7 仍依赖 canvas Spec 验收 12（用户手工走查）未确认，状态保持「已确认」。
- 2026-11-14 验收 7 收口：依赖的 [canvas-root-decomposition.md](canvas-root-decomposition.md) 验收 12 已由其 2026-11-14 条目确认（用户启动预览后授权助手走查并据结果改状态），验收 7 随之满足；验收 8 的契约测试缺口已在上一条补齐（`PublicApi.test.tsx`、`AssetsDialog` / `AssetBrowserPanel` / `DirectorOverlay` 公开 props 用例、`getProjectRevision` 缺项用例）。实现代码已随 `a2f521c0` 提交，全部验收标准通过；据用户授权将状态改为「已实现」。上方各条中的「验收 7 未确认 / 状态保持已确认」自本条起不再代表当前状态。

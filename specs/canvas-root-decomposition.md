# Canvas Root Decomposition（画布根组件拆分）

状态：已实现（2026-11-14 验收 12 走查通过、经用户授权设置；2026-11-04 修订：采用模块契约架构；2026-11-04 二次修订：项目写互斥归 `entities/project`，`AssetHoverPreview` 留在 assets（后由四次修订改判为泛化下沉），`features/model` 下沉，补齐页面加载门、保存 flush 与导演桥接契约；2026-11-04 三次修订：补齐资产库原始批量上传与共享音视频组件下沉，清除 `features/assets → features/canvas` 残留导入；2026-11-04 交叉核对：与 `specs/web-module-contracts.md` 对齐 `uploadMany` / `uploadOne` 逐项契约、`clamp01` 归属与 `features/settings` 的 canvas 边界；2026-11-04 四次修订：按审核结论修正保存循环依赖、输入闸门落位、`assetsDialog` 开关参数、公共 API 签名与悬浮预览归属；2026-11-04 五次修订：按二次审核结论修正 `CanvasSaveSource` 注册时机、`assetsDialog` slot 只注入插入动作、`CanvasPortsContext` 下发 ports、`nodeTypes` 模块级稳定、`AssetBrowserPanel` 拖拽路径与提示词预加载可用性语义；2026-11-04 六次修订：按三次审核结论修正设置门返回值语义、保存注册时机表述、用户菜单开关归属与 `canvas-save-source.ts` 落位；2026-11-04 用户确认；2026-11-09 七次修订：保存改为静态无环分层，删除 `CanvasSaveSource` 注册表，经用户授权调整核心架构）

## 背景

2026-11-04 的前后端结构盘点确认：画布功能整体分层清晰，`features/canvas` 已有 store、session、hook、shared 纯函数与控件分层，但两个组件承担了过多职责：

- `web/src/features/canvas/InfiniteCanvas.tsx`：1,545 行，52 处 `useCallback`。除 React Flow 装配外，还直接实现节点/边变更、连线判定与批量接驳、拖动/框选/缩放会话接线、文件拖放、右键菜单、生成面板宿主、资产库、设置抽屉、用户菜单与退出登录等。
- `web/src/features/canvas/nodes/VideoNode.tsx`：1,117 行，23 处 `useCallback`、12 处 `useEffect`。`VideoControls` 与节点渲染同文件；节点同时直接编排上传、裁剪、截取片段、分离音频、下载、收藏与播放状态。

本 Spec 的目标不是增加画布能力，而是把“页面组合 / React Flow 装配 / 交互域 / 浮层宿主 / 节点媒体编辑”拆成可独立理解和测试的模块，降低修改一处交互时的回归面。

跨 feature 边界的通用分层、公共 API、entity 契约与边界检查由 `specs/web-module-contracts.md` 统一定义。本 Spec 不再在方案 A/B 之间选择，只定义 canvas 作为首个试点如何落地该架构。

## 现状与已验证事实

- `InfiniteCanvas.tsx` 当前导入 `@/features/assets`、`@/features/auth`、`@/features/project`、`@/features/settings`；`web/eslint.config.mjs` 的 `boundaries/dependencies` 允许 `feature → feature`，因此这些跨领域依赖不会被 lint 阻止，但根组件已成为画布页的耦合枢纽。
- `InfiniteCanvas.tsx` 的 React Flow 配置没有 `translateExtent` / `nodeExtent`，`minZoom=0.1`、`maxZoom=5`，视口可无限平移；“Infinite”描述的是视口语义，不是根组件职责。
- `VideoNode.tsx` 直接导入 `@/features/canvas/api/file-api` 与 `@/features/canvas/editing/client-media/client-video`，媒体编辑 API 调用与节点 JSX 同处一文件。
- 现有回归基线：web 侧 195 个测试文件 / 1,579 个用例；`__tests__/features/canvas/stale-event-handler.test.ts` 锁定“事件处理器读取 store 实时状态”的约束。
- 跨 feature 依赖现状：
  - `VideoNode.tsx`、`ImageNode.tsx`、`NodeToolbar.tsx` 直接读 `@/features/assets/store`；`DirectorNode.tsx` 读 `@/features/director/director-store`；`hooks/use-file-drop.ts` 导入 `@/features/assets/add-asset` 的 `ASSET_DRAG_TYPE`。
  - 生成面板与 Agent 直接导入 `@/features/model/*`（`ImageGenerationPanel`、`VideoGenerationPanel`、`TextGenerationPanel`、`AgentDrawer`）；多个画布组件深导入 `@/features/media/*`（`ResolvedImage` / `ResolvedVideo` / `ResolvedHoverMedia` / 访问错误组件）。
  - `controls/CanvasControls.tsx` 导入 `@/features/auth/store` 与 `@/features/auth/UserContext`；`controls/ProjectToolbar.tsx` 导入 `@/features/auth/components/UserMenuPopover` 与 `@/features/project/store`。
  - `explorer/CanvasExplorer.tsx` 深层导入 assets 组件、store、hook；`stores/canvas-store.ts` 依赖 `@/features/project/save-manager`。
  - `features/assets/components/AssetsDialog.tsx` 反向导入 `@/features/canvas/stores/canvas-store` 的 `useCanvasStore`、`findFreePosition`、`getViewportCenter`；`features/assets/add-asset.ts` 导入 canvas 的 `node-defaults` 与类型，形成 assets ↔ canvas 双向耦合。
  - `features/assets/components/AssetCreateDialog.tsx` 使用 canvas `runMediaUpload` 的 raw sink 与 `pick-files` 的 `expandAccept` 做批量原始上传；`features/assets/components/AssetInspector.tsx` 使用 canvas `VideoPlayer` 与 `AudioWaveform` 做预览。前者是无画布副作用的“Blob → 远程引用”上传，后者是可共享的媒体播放 UI；仅处理 `AssetsDialog` 与 `createAssetNode` 仍会残留 assets → canvas 导入。
  - `features/settings/ApiSettingsDrawer.tsx` 导入 canvas store 的 `setModalOpen`；`features/media` 被 auth/assets/canvas/director 多个 feature 深导入。
- `features/project` 反向承担画布会话与持久化：`use-canvas-session.ts`、`save-manager.ts`、`canvas-lease.ts`、`session-expired-store.ts` 直接导入 canvas store/types；`features/project/types.ts` 导入 canvas 的节点/视口类型；`ProjectListPage.tsx` 导入 canvas `flushAndWait`。这些是画布文档会话/保存职责，不是项目列表职责。
- `features/project/save-mutex.ts` 不是画布专属：项目改名/封面与画布内容保存共用同一条写通道（文件注释已明确这一约束），同一标签页内必须串行，否则两条写通道并发会造成同页 409，破坏“409 即其他窗口”的会话过期判定。该互斥应归 `entities/project`，不能随画布保存一起迁入 canvas，否则 `entities/project` 的项目命令只能反向依赖 canvas 或各自再建一把锁。
- `features/director` 的 `DirectorOverlay.tsx` / `DirectorViewport.tsx` 直接导入 canvas store、canvas types 与 canvas upload；`features/auth/AvatarCropModal.tsx` 导入 canvas `uploadOne`。导演台与头像上传都属于消费方，不应反向依赖 canvas 内部。
- `web/src/app/(app)/canvas/[projectId]/page.tsx` 直接深导入 `InfiniteCanvas`、`useCanvasStore`、`useCanvasKeyboard`、assets store、project store、`CanvasLoader` 与 prompt 预设查询；页面虽已挂载快捷键弹窗和 DirectorOverlay，但开关状态仍存放在 canvas store。
- `web/src/providers/BatchConnectContext.tsx` 直接导入 `@/features/canvas/controls/use-batch-connect-drag`，属于 app 组合层对 canvas 内部的深导入。
- `features/canvas` 没有公共 barrel，页面直接深导入 `InfiniteCanvas`。
- Provider/会话现状：`ReactFlowProvider` 位于页面入口；`InfiniteCanvas.tsx` 在组件内使用 `useReactFlow`。`CanvasMediaLoadingProvider key={activeProjectId}` 包住 ReactFlow 与三个 session；`DragPreviewSession`、`MarqueeSession`、`ResizeSession` 在 `InfiniteCanvas.tsx` 中以 `useState` 创建，并在 effect/layout effect 中 dispose。`@xyflow/react/dist/style.css` 在 `InfiniteCanvas.tsx` 顶部导入。
- 现有约束冲突：`specs/canvas-drag-preview-session.md` 的“约束”一节写着“不拆分 `InfiniteCanvas` 文件”。已验证拖动会话、框选会话、缩放会话与多数交互 hook 已独立；本 Spec 据此提出拆分，但仍以不改变拖动提交时序为约束。**本 Spec 获用户确认后取代该约束；确认前不拆分该文件。**

## 目标

1. 页面入口只做页面组合：会话建立、加载门、跨 feature 页面壳、全局浮层；`CanvasRoot` 只做 canvas feature 内部装配，不拥有项目生命周期与其它 feature 的页面壳。
2. React Flow 实例与事件接线集中到单一装配层；节点/边变更、连线、指针与选择、文件拖放、视口动作各自成为独立 hook 或 session 接线。
3. `VideoNode` 只负责节点展示与子组件组合；播放控件、媒体编辑动作、上传/裁剪/截取/分离音频流程分别下沉。
4. 保持所有用户可见行为、store 数据契约、持久化数据、接口契约与性能特征不变。
5. 为拆分后的模块补充针对性的回归测试，避免只靠“大组件快照”覆盖。
6. canvas 试点落地模块契约：canvas 不导入其它 feature；跨 feature 数据只经 `entities/*` 公共 API；跨 feature UI 能力经 page 注入的 ports/slots；公共入口只导出页面级 canvas 契约（`CanvasRoot`、会话/加载/保存/导演桥接 hook 与公开类型），不导出 store/内部组件。

## 范围

- `web/src/features/canvas/InfiniteCanvas.tsx` 的职责拆分与入口迁移。
- `web/src/features/canvas/nodes/VideoNode.tsx` 的控件与媒体编辑动作拆分。
- 新增/调整的 `features/canvas/root/*`、`features/canvas/hooks/*`、`features/canvas/nodes/video/*`、`features/canvas/index.ts` 及对应测试。
- 页面入口 `web/src/app/(app)/canvas/[projectId]/page.tsx` 的页面组合、页面壳与导入路径调整。
- 依赖的前置契约迁移：
  - `entities/asset`、`entities/project`、`entities/user`、`entities/director` 的公共 API；
  - 画布文档/会话归属纠正：`use-canvas-session`、`save-manager`、`canvas-lease`、`session-expired-store`、`CanvasProject` / `CanvasData` / `CanvasDataDelta` / `HistorySnapshot` / `ClipboardData` 从 `features/project` 迁入 `features/canvas`；`adoptProject` 拆分见 [web-module-contracts.md](web-module-contracts.md) 规则 3（`adoptProject` 拆分）；`entities/project` 只保留项目摘要、列表、`activeProjectId`、revision 与项目命令；`ProjectListPage` 的 flush 改由 app 注入 `flushCanvasSave`；
  - 项目写互斥归属：`save-mutex` 不迁入 canvas，`entities/project` 暴露唯一写互斥（见 [web-module-contracts.md](web-module-contracts.md) 规则 1（项目写互斥与项目 API 拆分））；`features/project` 删除 `save-mutex.ts`，不保留转发；
  - 共享能力下沉：`features/media` 整体下沉为 `components/media`，canvas 的 `VideoPlayer`、`media-playback`、`useAudioWaveformInstance` 与通用 `AudioWaveform` 一并下沉；`AudioWaveform` 的画布播放注册表/截取锁/`nodrag` 由 canvas 通过 `registerPlayer` / `controlsLocked` / `interactionClassName` 注入，`audio-playback-registry` 留在 canvas；`clamp01` 下沉 `lib/utils/number` 供 canvas 与 shared 共用；`features/model` 的 `ModelSelector` / `ModelParamFields` / `ModelIcon` / `param-fields` 下沉为 `components/model`；`AssetHoverPreview` 泛化为 `components/media/MediaHoverPreview`（props 只含展示数据，`features/assets` 删除包装），`MediaType` 上移 `src/types/media.ts`；
  - 原始上传下沉：`features/canvas/upload` 的 `uploadMany` / `uploadOne` 下沉 `entities/asset`，canvas 删除 `{ kind: "raw" }` sink，只保留占位节点/替换/派生节点语义；`expandAccept` 与批次拆分/超限判定分别迁入 `lib/upload-formats`、`lib/utils/upload`；`createImageNodeFromRef` 留在 canvas，通过 page 级 `useDirectorBridge` 注入导演台；
  - `features/assets` 的 `AssetsDialog` 改为接收插入回调，并把 `CanvasExplorer` 现有资产快捷访问区（`AssetBreadcrumb` + `AssetGrid` + `useAssetLibrary` + 悬浮预览）原样抽为公共 `AssetBrowserPanel`（不新写浏览逻辑）；`AssetCreateDialog` 改用 `entities/asset.uploadMany` 与 `lib/upload-formats.expandAccept`，`AssetInspector` 改用 `components/media`，删除对 canvas 的导入；
  - `features/settings`、`features/auth`、`features/project`、`features/director` 删除 canvas 内部导入；
  - `providers/BatchConnectContext` 迁入 canvas；
  - `CanvasLoader` 迁入 `components/layout`。
- 边界执行：扩展 `web/eslint.config.mjs` 或新增 `module-boundaries.test.ts`，覆盖 canvas 试点的公共入口、feature 隔离、深导入与循环依赖。
- 因文件移动需要同步更新的注释、CSS 注释、测试 mock 路径与 `canvas-node-types` 导入。

## 非目标

- 不新增画布功能，不改变交互语义、视觉样式、快捷键、面板行为或错误提示。
- 不升级 React Flow，不启用画布虚拟化，不调整拖动/框选/缩放性能策略。
- 不修改节点/边数据结构、撤销历史、自动保存协议、持久化格式或服务端接口；页面壳开关（`shortcutsVisible`、`directorOverlayOpen`）从 canvas store 移出属于状态归属调整，不属于画布数据契约变更。
- 不重写 `AssetsDialog`、`ApiSettingsDrawer`、`UserMenuPopover`、`DirectorOverlay` 等其它 feature 的内部实现，只调整其公共 API、画布桥接与组合位置；`AssetBrowserPanel` 由 `CanvasExplorer` 现有资产快捷访问区原样抽出，不新写浏览逻辑。
- 不重写导演台 3D 引擎或项目列表 UI；只做 `DirectorOverlay` 公开 props / `useDirectorBridge`、`ProjectListPage` flush 回调等边界调整。
- 不为了拆文件而创建通用“画布引擎”、事件总线、DI 容器或跨模块全局上下文；没有真实职责边界的抽象不做。
- 不保留旧文件路径的兼容导出；所有调用方直接迁移。
- 不一次性迁移 canvas 之外的所有 feature；其它 feature 按 `specs/web-module-contracts.md` 的基线策略后续处理。

## 目标结构

```
web/src/
  app/
    (app)/canvas/[projectId]/page.tsx   # 画布页组合根：会话、加载门、页面壳、canvas 组合
    (app)/project/page.tsx              # 项目页组合根：向 ProjectListPage 注入 canvas 保存 flush
  components/
    layout/
      CanvasLoader.tsx                  # 画布加载门；从 features/canvas/shared 上移
    media/                              # 共享媒体：features/media + canvas VideoPlayer/AudioWaveform/media-playback/useAudioWaveformInstance
    model/                              # 由 features/model 下沉的模型选择/参数纯 UI 与纯函数
    ui/
  entities/
    asset/index.ts                      # 资产类型、读取 Hook/selector、命令、uploadMany/uploadOne 原始上传、ASSET_DRAG_TYPE
    project/index.ts                    # 项目摘要/列表、activeProjectId、revision、项目命令、runProjectWrite
    user/index.ts                       # 当前用户、偏好命令
    director/index.ts                   # 可序列化导演类型：Shot / SceneState / DirectorEntityState / DirectorStateData
  features/
    canvas/
      index.ts                          # 页面级 canvas 契约：CanvasRoot、会话/加载/保存/导演桥接、公开类型
      root/
        CanvasRoot.tsx                  # canvas 内部装配：Provider、Surface、Overlays、Explorer、Agent
        CanvasSurface.tsx               # React Flow 实例、节点/边类型、RF 回调、session 接线
        CanvasOverlays.tsx              # 浮层编排入口；节点级/全局级浮层分文件
        contracts.ts                    # CanvasRootProps / CanvasPorts / CanvasSlots
      contexts/
        BatchConnectContext.tsx         # 从 providers 迁入
      session/
        use-canvas-session.ts           # 从 features/project 迁入
        canvas-lease.ts
        session-expired-store.ts
      stores/
        canvas-document-store.ts        # 文档状态与纯写入叶子；发有界保存意图，不导入保存器
        canvas-store.ts                 # React 适配层：保持 useCanvasStore 调用面 + flushAndWait
      persistence/
        save-manager.ts                 # 从 features/project 迁入；直接读取文档 store 并订阅保存意图；写互斥使用 entities/project.runProjectWrite
        save-intent.ts                  # 文档 store → 保存器的有界保存意图
      hooks/
        use-canvas-node-changes.ts
        use-canvas-edge-changes.ts
        use-canvas-connections.ts
        use-canvas-pointer.ts
        use-canvas-viewport-actions.ts
        use-canvas-panels.ts
      nodes/
        VideoNode.tsx
        video/
          VideoControls.tsx
          use-video-node-actions.ts
    assets/
      index.ts                          # 公共 UI：AssetsDialog、AssetBrowserPanel 等
      components/
        AssetBrowserPanel.tsx           # 新公共资产浏览面板；不导入 canvas
    project/
      index.ts                          # 公共 UI：ProjectListPage 与其公开 props；不导入 canvas
    director/
      index.ts                          # 公共 UI：DirectorOverlay 与其公开 props；不导入 canvas
```

以上文件名是候选落位，不是硬性契约；最终以“一个模块只有一个变化原因”为准。若某个候选组件只转发 props、没有独立职责，则不拆（AGENTS 三.5）。已有 `use-canvas-events`、`use-canvas-interaction`、`use-add-node`、`use-group-operations`、`use-file-drop`、`use-canvas-keyboard` 等继续复用，禁止新建重复 hook。

## 页面组合根与 CanvasRoot

### page.tsx

`web/src/app/(app)/canvas/[projectId]/page.tsx` 是唯一页面组合根，负责：

- 读取 URL `projectId`，调用 canvas 公共 `useCanvasSession(projectId): CanvasSessionStatus`（`"connecting" | "ready" | "missing" | "error"`，存量实现从 `features/project` 迁入）；会话未 ready 或设置未就绪时只渲染 `components/layout/CanvasLoader`。设置门与现有实现一致：并行执行模型库 `useModelStore.initialize()`、资产库 `entities/asset.initialize()` 与 `preloadCanvasPromptTemplates(queryClient)`；两个 store 的 `initialize()` 均返回 `Promise<void>`，settle 后读取各自 `initialized`（失败时保持 `false` 以允许重试）；`preloadCanvasPromptTemplates` 返回 `true` 当且仅当“当前存在可用提示词目录”（刷新成功，或刷新失败但 `queryClient` 已有缓存数据）。三个结果全为真才 ready；任一为假进入 failed，`CanvasLoader` 展示失败文案与重试按钮（`failed` / `onRetry`），重试时先同步置回 loading。
- 持有 `ReactFlowProvider` 唯一实例、`AppShell` 与 `CanvasRoot`。
- 持有页面级开关与浮层：`assetsOpen`、`settingsOpen`、`shortcutsVisible`、`directorNodeId`、`logoutConfirmOpen`、`deleteConfirmOpen`；渲染 `ApiSettingsDrawer`、快捷键弹窗、`DirectorOverlay`、退出/删除确认框与会话过期弹窗。`AssetsDialog` 的内容由 page 构造：page 闭包同时持有 `assetsOpen`、开关回调与对话框其余 props，slot 渲染函数只把 canvas 注入的插入动作合入（`<AssetsDialog open={assetsOpen} onOpenChange={setAssetsOpen} {...api} />`），因此 `CanvasRoot` / `CanvasSurface` 不持有资产弹窗开关。
- 用 `entities/project` 的 `activateProject(projectId)` 标记当前项目；用 `entities/asset` 的初始化命令拉齐资产库；用 canvas 公共 `preloadCanvasPromptTemplates(queryClient): Promise<boolean>` 拉齐提示词目录并返回当前是否存在可用目录（刷新失败但已有缓存仍为 `true`）。页面不再导入 assets/project/canvas 的 store 或 query key。
- 用 `entities/user`、`entities/project` 的公共 API 构造用户菜单项与项目删除/退出动作，通过 `slots.userMenu` 注入 canvas；页面不把 entity store 传给 canvas。
- 用 canvas 公共 `useSessionExpired(): boolean` 读取编辑权过期状态；用 `useDirectorBridge(directorNodeId)` 取得 `DirectorOverlay` 所需的 `initialState` / `onSaveState` / `onCreateImageNode`，`onOpenDirector(nodeId)` 只负责把 `directorNodeId` 写为 page 本地 state。
- 把 `ports`（打开资产库/设置/快捷键/Director）与 `slots`（用户菜单、资产浏览器、资产弹窗）传给 `CanvasRoot`。
- 把页面浮层的打开状态（`assetsOpen`、`settingsOpen`、`shortcutsVisible`、`directorNodeId !== null`、`logoutConfirmOpen`、`deleteConfirmOpen`）折算为 `inputBlocked`，传给 `CanvasRoot`；canvas 内部把它与 `modalOpen` 合并后统一阻断画布快捷键与编辑面板输入。

页面不得直接导入 `features/canvas` 内部路径；只从 `@/features/canvas` 公共入口导入 `CanvasRoot`、`useCanvasSession`、`useSessionExpired`、`useDirectorBridge`、`preloadCanvasPromptTemplates`、`flushCanvasSave` 与公开类型。

`web/src/app/(app)/project/page.tsx` 是项目页组合根：从 `@/features/canvas` 公共入口取得 `flushCanvasSave`，以 `flushPendingCanvasSaves` prop 传给 `ProjectListPage`。`features/project` 不再导入 canvas；`ProjectListPage` 只调用注入的回调。该路由壳必须是客户端组件（`"use client"`）或由一个最小客户端桥组件注入——Server Component 不能把函数 prop 传给 Client Component。

`flushCanvasSave(): Promise<void>` 的行为与现有 `saveManager.flushAndWait()` 一致：清除待触发的防抖保存，等待在途保存完成，并在仍有 dirty 时补一次普通保存；单次等待上限 5s，整体截止 15s；始终 resolve、不 reject，超时只记录告警并放行（未落库改动仍保持 dirty，后续继续重试）。`ProjectListPage` 在进入项目列表路由时调用它（即从画布返回列表；从画布直接导航到其它路由不触发），并在其 `finally` 中刷新项目列表；不得因保存失败阻塞路由切换。

### CanvasRoot

`CanvasRoot` 是 canvas feature 的内部根，不是页面根。它接收：

```ts
interface CanvasRootProps {
  projectId: string;
  ports: CanvasPorts;
  slots: CanvasSlots;
  inputBlocked?: boolean;
}

interface CanvasPorts {
  onOpenAssets: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenDirector: (nodeId: string) => void;
}

interface CanvasSlots {
  userMenu: (api: {
    trigger: React.ReactElement;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => React.ReactNode;
  assetBrowser: (api: {
    onInsertAsset: (asset: AssetItem) => void;
  }) => React.ReactNode;
  assetsDialog: (api: {
    onInsertAsset: (asset: AssetItem) => void;
    onInsertAssets: (assets: AssetItem[]) => void;
  }) => React.ReactNode;
}
```

`CanvasRoot` 负责：

- `CanvasMediaLoadingProvider key={projectId}`；`projectId` 来自 props，不读 project store 的 `activeProjectId`。
- `CanvasSurface`（内含 `CanvasOverlays`）、`CanvasExplorer`、`CanvasAgentDrawer`、拖动预览浮层等 canvas 内部 UI。
- 用 canvas 内部 `CanvasPortsContext` 提供 `ports`：`CanvasSurface`、`ProjectToolbar`、`CanvasControls` 与节点组件（如 `DirectorNode`）通过 `useCanvasPorts()` 读取，`CanvasSurface` 不再接收 `ports` prop；`CanvasSurface` 只接收收窄后的 `CanvasSurfaceSlots`（当前仅 `userMenu`）。
- slot 分发：`slots.userMenu` 交给 `ProjectToolbar`（只渲染该 slot，不导入 auth UI）；`slots.assetBrowser` 由 `CanvasRoot` 直接交给 `CanvasExplorer`；`slots.assetsDialog` 由 `CanvasRoot` 自己渲染（资产弹窗需要 canvas 的插入动作），只有这一个挂载点，page 不得再渲染一份。`CanvasSurface` 的插槽类型收窄为 `CanvasSurfaceSlots = Pick<CanvasSlots, "userMenu">`，`assetBrowser` / `assetsDialog` 不得经 `CanvasSurface` 透传。
- 通过 canvas 内部 `CanvasInputGateContext` 把 `inputBlocked` 与 canvas store 的 `modalOpen` 合并为 `inputBlocked || modalOpen`，向 canvas 读者暴露 `useCanvasInputBlocked(): boolean`；不把页面壳开关写入 canvas store。
- 通过 canvas 内部 `CanvasShellContext` 向 `CanvasControls`、`CanvasLeftPanels`、`CanvasAgentEntry` 等提供 `explorerOpen` 与稳定的 `toggleExplorer` / `openAgent`；shell 值以 `useMemo` 稳定，页面壳开关的权威状态仍由 page 持有，canvas 不复制或持久化该状态。

`CanvasRoot` 不负责项目加载/切换/卸载、用户菜单内容、资产弹窗内容、API 设置、快捷键弹窗、DirectorOverlay 或退出/删除确认；这些属于 page 组合层。`CanvasRoot` 不持有 `directorNodeId`，也不挂载 `DirectorOverlay`；`ports.onOpenDirector(nodeId)` 经 `CanvasPortsContext` 下发，由 `DirectorNode` 等节点组件调用上报。

`CanvasPorts` / `CanvasSlots` 全部为必填：缺失的能力以显式的 no-op 或 `() => null` 实现，不使用可选属性或 `?.` 兜底；page 必须用模块级函数或 `useCallback` / `useMemo` 提供稳定引用，避免 `CanvasRoot` / `CanvasSurface` 因父级重渲染产生新 props。唯一例外是 `slots.assetsDialog`：其渲染函数由 page 闭包捕获 `assetsOpen`，开关变化时引用必然变化。因此 `CanvasRoot` 不得把该 slot 传给 `CanvasSurface`、不得写入任何 effect 依赖，slot 收到的 api 对象由 `CanvasRoot` 以 `useMemo` 稳定；`slots.assetsDialog` 的挂载只依赖稳定成员。

### useDirectorBridge

canvas 公共入口暴露页面级导演桥接，`features/director` 不再读取 canvas store：

```ts
interface DirectorImageNodeInput {
  ref: string;
  width: number;
  height: number;
  name: string;
}

interface DirectorBridge {
  initialState: DirectorStateData | null;
  onSaveState: (state: DirectorStateData) => void;
  onCreateImageNode: (input: DirectorImageNodeInput) => Promise<void>;
}

function useDirectorBridge(directorNodeId: string | null): DirectorBridge;
```

- `initialState`：从 `directorNodeId` 对应节点当前的 `data.directorState` 读取；`directorNodeId` 为 `null` 或节点不存在时为 `null`。`DirectorOverlay` 挂载时据此恢复场景，不再读取 canvas store。
- `onSaveState(state)`：把 `state` 写入 `directorNodeId` 对应节点（`updateNodeData(nodeId, { directorState: state })`），不重置 director store。
- `onCreateImageNode(input)`：调用 canvas 内部 `createImageNodeFromRef`，由 canvas 决定落点与节点默认值；`ref` / `width` / `height` / `name` 来自导演镜头，director feature 不感知 canvas 节点类型。`directorNodeId` 为空或对应节点已不存在时，`onSaveState` / `onCreateImageNode` 均为 no-op（不写节点、不压历史、不抛错），与现有“节点不存在直接返回”的行为一致。
- 关闭顺序固定：`DirectorOverlay` 先 `runtime.captureState()`，再调用 `onSaveState(state)`，随后 `useDirectorStore.getState().reset()`，最后调用 page 的 `onClose()` 清除 `directorNodeId`。`onSaveState` 必须发生在 page 清除 `directorNodeId` 之前，否则节点状态写入会丢失。
- `useDirectorBridge` 返回的回调必须保持稳定引用；page 只持有 `directorNodeId` 并渲染 `DirectorOverlay`，不把 director store 或 canvas store 传给 overlay。

### CanvasSurface

`CanvasSurface` 负责：

- `<ReactFlow>` 的 props、`nodeTypes` / `edgeTypes` 引用、`onNodesChange` / `onEdgesChange` / `onConnect*` / `onNodeDrag*` / `onPane*` 等回调接线。
- 创建并持有 `DragPreviewSession`、`MarqueeSession`、`ResizeSession` 实例，并在 surface 内提供 `ResizeSessionContext` / `BatchConnectContext`，覆盖 ReactFlow 与 surface 级控件。
- 视口动作（reset view / fit / tidy）从 hook 取得。
- `nodeTypes` / `edgeTypes` 在模块级稳定创建（模块级常量），不随渲染重建；节点需要的 page 注入动作（如 `onOpenDirector`）经 `CanvasPortsContext` 的 `useCanvasPorts()` 读取，不写入持久化 `node.data`。
- 直接渲染 canvas 自有的 `ProjectToolbar`、`CanvasControls`；两者通过 `useCanvasPorts()` 读取页面动作，`ProjectToolbar` 另接收 `slots.userMenu`，`CanvasSurface` 不再接收 `ports` prop，也不再接收 `surfaceControls` 整棵控件树。`ProjectToolbar` 的项目名/重命名使用 `entities/project` 公共契约；`CanvasControls` 的当前用户/主题/语言偏好使用 `entities/user` 公共契约。
- React Flow 的 `colorMode` 通过 shared `components/ui/theme-mode` 的 `useThemeMode()` 读取；`ThemeModeProvider` 由 app 组合根挂载，`CanvasSurface` 不得导入 auth feature 或用户 store 来推导主题。
- 三个 session 与两个 context 的嵌套顺序不承载业务语义；`CanvasSurface` 整体位于 `CanvasMediaLoadingProvider` 内层。

`CanvasSurface` 不得导入 auth/assets/project/settings 的 feature 内部路径，也不得直接渲染页面壳。

### CanvasOverlays

`CanvasOverlays` 负责：按 store 中的节点 id 挂载动态编辑面板与节点工具条；只决定“挂载/可见/位置”，不实现裁剪、截取、标注等业务规则。节点级浮层与全局浮层分文件（如 `root/overlays/node-overlays.tsx`、`root/overlays/global-overlays.tsx`），`CanvasOverlays.tsx` 只做编排。

### 其它 feature 的公共 API 调整

- `features/assets`：
  - `AssetsDialog` 当前开关 props 为 `open` / `onClose`，改造为受控 `open` / `onOpenChange`，并新增 `onInsertAsset` / `onInsertAssets` props；page 通过 `slots.assetsDialog` 只注入 canvas 插入动作，开关仍由 page 闭包绑定。删除对 `@/features/canvas/stores/canvas-store`、`findFreePosition`、`getViewportCenter` 的导入。
  - 新增 `AssetBrowserPanel` 公共 UI，供 page 组装后通过 `slots.assetBrowser` 注入 `CanvasExplorer`；面板只负责资产浏览/选择，点击插入时调用传入的 `onInsertAsset`。拖拽插入不走 `onInsertAsset`：仍由 `AssetCard` 的 `draggable` 写入 `entities/asset.ASSET_DRAG_TYPE` 数据，canvas `use-file-drop` 读取同一常量处理落点。
  - `createAssetNode` 从 `features/assets/add-asset.ts` 迁入 canvas（它依赖 canvas 节点类型与默认值）；`ASSET_DRAG_TYPE` 归 `entities/asset`，值保持 `"application/x-asset"`，`features/assets` 与 canvas 的拖放处理都从 entity 导入，不得各自定义常量。
  - `uploadMany` / `uploadOne` 迁入 `entities/asset`；公共契约与 canvas 上传出口以 [web-module-contracts.md](web-module-contracts.md) 规则 6.1（上传职责（Blob → 远程引用））、规则 6.2（逐项结果与错误分类）、规则 6.3（无画布副作用与 `uploadOne` 包装）、规则 6.5（canvas 上传出口）、规则 6.6（`expandAccept` 归属）为准，本 Spec 不再复制正文。
  - `expandAccept` 迁入 `lib/upload-formats`；`AssetCreateDialog` 的批量上传改用 `entities/asset.uploadMany`，`AssetInspector` 的 `VideoPlayer` / `AudioWaveform` 改用 `components/media`；两者都不再导入 canvas。
  - `AssetHoverPreview` 删除并泛化为 `components/media/MediaHoverPreview`（`{ name; mediaType; fileKey?; plainText?; enabled?; children }`），`MediaType` 上移 `src/types/media.ts`；资产卡片与 canvas `CanvasExplorer` 资产行都直接使用 shared 组件。canvas 不再直接导入 assets 的预览组件——资产浏览由 page 经 `slots.assetBrowser` 注入的 `AssetBrowserPanel` 承担。
  - `features/assets` 不再导入任何 canvas 路径。
- `features/settings`：`ApiSettingsDrawer` 不再导入 canvas store；页面持有 `settingsOpen` 并计入 `inputBlocked`。
- `features/auth`：用户菜单与设置弹窗保持 feature UI；当前用户/偏好命令归 `entities/user`；`AvatarCropModal` 的上传改走 `entities/asset` 的 `uploadOne`，不再导入 canvas。`CanvasControls` 不再导入 auth feature。
- `features/project`：`use-canvas-session`、`save-manager`、`canvas-lease`、`session-expired-store` 与 `CanvasProject` / `CanvasData` / `CanvasDataDelta` / `HistorySnapshot` / `ClipboardData` 迁入 `features/canvas`；`adoptProject` 拆分与写互斥归属见 [web-module-contracts.md](web-module-contracts.md) 规则 1（项目写互斥与项目 API 拆分）、规则 3（`adoptProject` 拆分）；`entities/project` 只保留项目摘要/列表、`activeProjectId`、revision、项目命令与 `runProjectWrite`；`save-mutex.ts` 删除。`ProjectListPage` 新增 `flushPendingCanvasSaves` prop，由 `app/(app)/project/page.tsx` 注入 canvas 公共 `flushCanvasSave`；`features/project` 不再导入 canvas。
- `features/director`：`Shot` / `SceneState` / `DirectorEntityMeta` / `DirectorStateData` / `DirectorEntityState` 归 `entities/director`；只有运行时联合 `DirectorEntity` 留在 `features/director`；`DirectorOverlay` 改为公开 props `initialState` / `onSaveState` / `onCreateImageNode` / `onClose`，不再从 canvas store 写节点。`DirectorViewport` 的图片入库走 `entities/asset` 的 `uploadOne`，创建画布节点改由 `onCreateImageNode` 回调完成。page 通过 canvas 公共 `useDirectorBridge(directorNodeId)` 提供这些 props；`DirectorNode` 只经 `useCanvasPorts().onOpenDirector(nodeId)` 上报，`features/director` 不再导入 canvas。`DirectorNodeData` 仍留在 `features/canvas/types.ts`；director store 的 `openingNodeId` / `restoreState` 与对应 setter 随桥接迁移删除，不保留兼容字段。
- `features/media`：整体迁移为 `components/media`，并承接 canvas 的 `VideoPlayer`、`media-playback`、`useAudioWaveformInstance` 与通用 `AudioWaveform`；`AudioWaveform` 只通过 `registerPlayer` / `controlsLocked` / `interactionClassName` 接收画布适配，`audio-playback-registry` 留在 canvas；`clamp01` 下沉 `lib/utils/number`，shared 与 canvas `clip-range` 共用；`AssetHoverPreview` 删除并泛化为 `MediaHoverPreview`，`MediaType` 上移 `src/types/media.ts`；所有调用方改用共享层路径。
- `features/model`：`ModelSelector` / `ModelParamFields` / `ModelIcon` / `param-fields` 迁移为 `components/model`，作为无状态模型 UI；生成面板与 Agent 改从共享层导入。模型库业务状态仍在 `lib/model-store`（存量例外），本期不迁 entity。

## 状态归属

拆分前先确定状态归属，禁止同一状态在 page/CanvasRoot/surface/store 各存一份。

| 状态/能力 | 归属 | 生命周期与约束 |
| --- | --- | --- |
| `activeProjectId` | `entities/project` | page 调用 `activateProject(projectId)`；`CanvasRoot` 只接收 `projectId` prop，不读 entity store 作为画布身份 |
| 项目加载/切换/卸载、编辑权会话建立 | page（canvas 公共 `useCanvasSession`） | 项目切换由 page 重新渲染/重挂 canvas 子树；会话过期状态经 canvas 公共 `useSessionExpired` 暴露 |
| 项目名、重命名、项目列表 | `entities/project` | `ProjectToolbar` 通过公共 selector/命令读取；不进入 canvas store |
| 画布文档、保存管理、租约 | `features/canvas` 的 `stores/`、`persistence/` 与 `session/` | `save-manager` 通过 `entities/project` 的 revision/元数据命令落库；写互斥与保存依赖方向见 [web-module-contracts.md](web-module-contracts.md) 规则 1（项目写互斥与项目 API 拆分）、规则 2（画布文档与保存的静态分层） |
| 当前用户、主题/语言偏好 | `entities/user` | `CanvasControls` 通过公共 selector/命令读取；不进入 canvas store |
| 资产列表、文件夹、资产选择数据 | `entities/asset` | 资产 UI 与 Explorer 只读公共 selector/命令；不复制资产列表到 canvas store |
| `assetsOpen` / `settingsOpen` / `shortcutsVisible` / `directorNodeId` / logout / delete 页面壳开关 | page | 不写入 canvas store（store 删除 `shortcutsVisible` / `directorOverlayOpen`）；以 `inputBlocked` 折算输入阻断；`assetsDialog` 只通过 slot 挂载，slot 只注入插入动作，`open` / `onOpenChange` 由 page 闭包绑定 |
| 用户菜单开关（`menuOpen`） | `ProjectToolbar` 局部 state | `CanvasSlots.userMenu` 的 `open` / `onOpenChange` 由 `ProjectToolbar` 提供；不提升到 page，也不写入 canvas store |
| `canvasExplorerOpen`、`chatOpen`、拖动预览等 canvas 自有浮层 | `CanvasRoot` 局部 state | 变化不得触发 `CanvasSurface` 重挂或 ReactFlow 额外提交 |
| `nodes` / `edges` / selection / interaction | 现有 canvas store | 拆分不修改节点/边/selection/undo/save 的数据契约与 action 语义 |
| `modalOpen`（canvas 内部编辑面板输入闸门） | canvas store（只写）；合并值经 `CanvasInputGateContext` 暴露 | `useCanvasInputBlocked()` 返回 `inputBlocked \|\| modalOpen`；快捷键、截取/波形面板、Escape 关闭 hook 只读该值；page 的 `settingsOpen` / `shortcutsVisible` / `directorNodeId` 等折算进 `inputBlocked`，不写 canvas store |
| `editingNodeId`、`editingTextNodeId`、`inspectedNodeId`、`pendingConnectionCreate`、`isFileDragging`、`toolbarDismissSignal`、`toolbarMode`、`selectionKey` | `CanvasSurface` 或其下层 hook；现有 store 已承担者保持 | 仅 surface 子树消费；不得为拆分提升到 `CanvasRoot` 形成 props drilling |
| `DragPreviewSession`、`MarqueeSession`、`ResizeSession` | `CanvasSurface` | 每个 surface 实例创建一次；项目切换/卸载 dispose；StrictMode 双挂载幂等 |
| 动态编辑面板/工具条的挂载条件 | `CanvasOverlays` 读取 store 或接收节点 id | 只决定挂载/可见/位置，不拥有业务状态 |

## Provider 树与会话生命周期

`ReactFlowProvider` 继续由页面入口持有唯一实例；`CanvasSurface` 必须位于其内部。不得在 `CanvasRoot` 或 `CanvasSurface` 再包一层 `ReactFlowProvider`，否则 `useReactFlow` / `RfNodeToolbar` 会读到不同 store。

目标 Provider 树（缩进表示嵌套）：

```
page.tsx
  ReactFlowProvider
    AppShell
      CanvasRoot projectId ports slots inputBlocked
        CanvasPortsContext.Provider value={ports}
          CanvasInputGateContext.Provider value={inputBlocked || modalOpen}
            CanvasShellContext.Provider value={shell}
              CanvasMediaLoadingProvider key={projectId}
                CanvasSurface slots
                  BatchConnectContext.Provider
                    ResizeSessionContext.Provider
                      CanvasOverlays（节点工具条等需要 RF context 的浮层）
                      ReactFlow
                        ...节点 / 边 / 框选层
                        ProjectToolbar（slots.userMenu；ports 经 context）
                        CanvasControls（ports / shell 经 context + entities/user）
              CanvasExplorer（slots.assetBrowser）
              CanvasAgentRuntimeBridge
              CanvasAgentDrawer
              assetsDialog slot（page 构造的 AssetsDialog，唯一挂载点）
    ApiSettingsDrawer / shortcuts Dialog
    DirectorOverlay（props 来自 useDirectorBridge(directorNodeId)）
    logout / delete confirm
  session expired modal（加载门外，page 顶层）
```

| Provider | 归属 | 约束 |
| --- | --- | --- |
| `ReactFlowProvider` | page 入口 | 唯一实例；`CanvasSurface`、`CanvasOverlays` 中依赖 RF context 的浮层都在其内 |
| `CanvasPortsContext.Provider` | `CanvasRoot` | 唯一实例，值即 `ports` prop（page 保证稳定引用因此无需再 memo）；`CanvasSurface`、`ProjectToolbar`、`CanvasControls` 与节点组件经 `useCanvasPorts()` 读取；`CanvasSurface` 不再接收 `ports` prop |
| `CanvasInputGateContext.Provider` | `CanvasRoot` | 唯一实例，值为 `inputBlocked \|\| modalOpen`；canvas 读者只经 `useCanvasInputBlocked()` 读取合并结果，不直接读页面壳开关，也不把该值写入 canvas store |
| `CanvasShellContext.Provider` | `CanvasRoot` | 唯一实例，提供 `explorerOpen` 与稳定的 `toggleExplorer` / `openAgent`；值以 `useMemo` 稳定；页面壳状态的权威来源仍是 page，canvas 不持有副本 |
| `CanvasMediaLoadingProvider key={projectId}` | `CanvasRoot` | 必须包在 `CanvasSurface` 外层，作为项目切换时 session 重建的唯一边界；key 变化会连同 `CanvasSurface` 子树一起重挂 |
| `BatchConnectContext.Provider` | `CanvasSurface` | 位于 `CanvasMediaLoadingProvider` 内层，覆盖 ReactFlow 与 surface 级控件；不与 CanvasMedia 互相消费，内外顺序不承载语义 |
| `ResizeSessionContext.Provider` | `CanvasSurface` | 位于 `BatchConnectContext` 内层，覆盖 ReactFlow 与 resize handle；同样不与其它 provider 互相消费 |
| `CanvasOverlays` 挂载点 | `CanvasSurface` 子树（`ReactFlowProvider` 内，建议位于两个 session context 内层、与 ReactFlow 同级） | 依赖 RF context 的节点工具条/浮层必须在 provider 内；只决定挂载/可见/位置 |

说明：`BatchConnectContext` / `ResizeSessionContext` 均位于 `CanvasMediaLoadingProvider` 内层且由 `CanvasSurface` 持有；这两个 provider 之间没有消费关系，顺序变化不改变任何上下文值或渲染结果。`CanvasRoot` 的 `CanvasPortsContext` / `CanvasInputGateContext` / `CanvasShellContext` 是 canvas 内部装配层，分别承载页面注入的能力、输入闸门与画布壳动作，页面壳状态的权威来源仍在 page。若实现时发现存在隐藏依赖，必须停止并先更新本表，不得新增表外 provider 或用复制 context 兼容。

会话生命周期规则：

1. 三个 session 只在 `CanvasSurface` 首次挂载时创建；不得在 render 期间重建，不得因 root 的浮层开关或无关 store 变化而重建。
2. 项目切换由 `CanvasMediaLoadingProvider key={projectId}` 重挂 `CanvasSurface`，session 随组件卸载 dispose；不得跨项目复用。
3. StrictMode 双挂载下，`attach` / `dispose` 必须幂等；事件监听、rAF、DOM 行内样式与 selection 抑制属性不得残留。
4. `ResizeSessionContext` / `BatchConnectContext` 的值必须稳定；不得因 root 重渲染产生新的 context 值。

## 模块契约与依赖

canvas 试点遵循 `specs/web-module-contracts.md` 的通用规则，本节只列 canvas 的具体落位：

1. `app` 只从 `@/features/canvas` 公共入口导入页面级契约：`CanvasRoot`、`useCanvasSession`、`useSessionExpired`、`useDirectorBridge`、`preloadCanvasPromptTemplates`、`flushCanvasSave` 与公开类型；不得深导入 `features/canvas/root/*`、`stores/*`、`hooks/*`、`session/*`、`persistence/*`。
2. `features/canvas` 不得导入任何其它 feature；跨 feature 领域数据只从 `@/entities/asset`、`@/entities/project`、`@/entities/user`、`@/entities/director` 的公共 API 获取；共享媒体与模型 UI 从 `@/components/media`、`@/components/model` 获取。
3. 页面级 UI 能力通过 `CanvasPorts` / `CanvasSlots` 由 page 注入；`CanvasRoot` 以 `CanvasPortsContext` 向 canvas 内部下发 `ports`，slot 按 `CanvasRoot` 声明的分发点下发（`slots.userMenu` → `ProjectToolbar`，`slots.assetBrowser` → `CanvasExplorer`，`slots.assetsDialog` → canvas 根）；`CanvasSurface` 只接收 `CanvasSurfaceSlots`（`userMenu`），不得透传其它 slot；不导入其它 feature 的 Context、store 或组件。
4. `features/canvas/index.ts` 只导出页面级契约：`CanvasRoot`、`CanvasRootProps` / `CanvasPorts` / `CanvasSlots`、`useCanvasSession`、`useSessionExpired`、`useDirectorBridge`、`preloadCanvasPromptTemplates`、`flushCanvasSave`，以及页面/导演桥接所需的公开类型；不导出 store、内部 hook、内部组件。
5. `entities/project` 不导出画布文档、保存编排或会话类型，但导出全项目唯一的 `runProjectWrite`（互斥范围见 [web-module-contracts.md](web-module-contracts.md) 规则 1（项目写互斥与项目 API 拆分））；`entities/asset` 的 `uploadMany` / `uploadOne` 符合规则 6.3（无画布副作用与 `uploadOne` 包装）；`entities/director` 不导出 canvas 节点类型；canvas 不另建写互斥。
6. 类型-only 导入与运行时导入使用同一规则；禁止 `import type` 绕过边界。
7. 公共 API 使用显式命名导出，禁止 `export *`；禁止 barrel 转发其它模块导出。
8. 模块依赖必须无环；`features/canvas` 内部可以相对/自身路径深导入，跨模块必须走公共入口。
9. 不引入事件总线、DI 容器、全局可变注册表或 `window` 自定义事件；跨模块协作只通过 page 注入的 ports/slots 与 entity 契约。
10. `providers` 按 app 层处理：不得导入 canvas 内部；`BatchConnectContext` 迁入 canvas 后，`providers` 不再引用 canvas 路径。
11. 边界检查必须可执行：扩展 `web/eslint.config.mjs` 的 `boundaries` 元素/策略，或新增 TypeScript AST 架构测试；仅文档约定不算完成。

## 迁移顺序

采用“契约先行、页面组合、内部拆分”的顺序，每一步保持测试绿：

1. **基线**：保留现有测试，补拖动提交、框选、连线落到空白、编辑面板开关的集成级回归；记录当前拖动/框选长任务与 ReactFlow 提交次数基线。
2. **共享层与 entity 契约**：`features/media` → `components/media`，同时把 canvas `VideoPlayer` / `AudioWaveform` / `media-playback` / `useAudioWaveformInstance` 下沉，画布注册/截取锁/`nodrag` 改为 props 适配；`features/model` 纯 UI → `components/model`；`AssetHoverPreview` 泛化为 `components/media/MediaHoverPreview` 并删除 assets 包装，`MediaType` 上移 `src/types/media.ts`；建立 `entities/asset`、`entities/project`、`entities/user`、`entities/director` 公共 API（含 `DirectorEntityMeta`）；`uploadMany` / `uploadOne` 迁入 `entities/asset`，`expandAccept` 迁入 `lib/upload-formats`，canvas 删除 raw sink；迁移 canvas 直接依赖（节点读 assets、DirectorNode 读 director entity、CanvasControls 读 user entity、生成面板读 `components/model`）。
3. **会话与保存归属纠正**：把 `use-canvas-session`、`save-manager`、`canvas-lease`、`session-expired-store` 与画布文档类型从 `features/project` 迁入 `features/canvas`；`save-mutex` 重建为 `entities/project.runProjectWrite` 并删除旧文件（互斥范围见 [web-module-contracts.md](web-module-contracts.md) 规则 1（项目写互斥与项目 API 拆分））；`save-manager` 按规则 2（画布文档与保存的静态分层）直接读取 `canvas-document-store` 并订阅保存意图；`adoptProject` 按规则 3（`adoptProject` 拆分）拆分；`entities/project` 只保留摘要/列表/`activeProjectId`/revision/命令；`app/(app)/project/page.tsx` 向 `ProjectListPage` 注入 `flushCanvasSave`，删除 project → canvas 导入。
4. **页面组合与公共契约**：`CanvasLoader` 迁入 `components/layout`；建立 `features/canvas/index.ts` 页面级契约；`page.tsx` 改用 `useCanvasSession` / `useSessionExpired` / `preloadCanvasPromptTemplates` / `useDirectorBridge` 并接管页面壳与浮层开关，页面壳状态折算为 `inputBlocked`；`CanvasRoot` 接收 `projectId` / `ports` / `slots` / `inputBlocked`，经 `CanvasPortsContext` 下发 `ports`、经 `CanvasInputGateContext` 暴露 `useCanvasInputBlocked()`；`CanvasSurface` 改为只接收 `slots`；`AssetsDialog` 自身 props 由 `open` / `onClose` 改为 `open` / `onOpenChange` 并新增插入回调，slot api 只含插入动作、开关由 page 闭包绑定；抽出 `AssetBrowserPanel`（保留 `ASSET_DRAG_TYPE` 拖拽路径）、`ProjectToolbar` 用户菜单 slot、`CanvasExplorer` 资产浏览器 slot；删除 assets/settings/auth/project/director 对 canvas 的导入。
5. **纯 hook**：逐个抽出 `use-canvas-node-changes`、`use-canvas-edge-changes`、`use-canvas-connections`、`use-canvas-pointer`、`use-canvas-viewport-actions`、`use-canvas-panels`，每次只搬一个交互域并保持测试绿。
6. **VideoNode**：先抽 `VideoControls`，再抽 `use-video-node-actions`；保持 `videoRef`、effect 顺序与清理语义。
7. **Overlays**：按节点级/全局级拆浮层文件，保持 `next/dynamic` 懒加载与挂载条件。
8. **Surface**：迁移 ReactFlow 接线、三个 session、两个 context 与控件渲染；验证项目切换/StrictMode 生命周期。
9. **Root 与收口**：重命名为 `CanvasRoot`，收紧公共 barrel，删除 `InfiniteCanvas`，启用边界 lint/架构测试并清零 canvas/entities 相关基线；最后跑全量检查。

## 交互 hook

- 每个 hook 只拥有一个交互域，返回该域需要的事件回调与只读派生值；不得把节点变更、连线、文件拖放塞进同一个“大 hook”。
- 事件处理器继续读取 store 实时状态（`useCanvasStore.getState()` 或稳定的 store action），不得用渲染期闭包捕获可变数据；`stale-event-handler.test.ts` 必须原样通过。
- 返回的回调必须保持稳定身份；新增 `useMemo` / `useCallback` 的依赖必须完整，禁止用空依赖掩盖闭包问题。
- `use-canvas-keyboard` 从 page 移入 canvas 内部；打开快捷键说明调用 `ports.onOpenShortcuts`，不再写 canvas store 的页面壳字段。
- `DirectorNode` 通过 `useCanvasPorts().onOpenDirector(node.id)` 打开 DirectorOverlay，不再读写 canvas store 的 `directorOverlayOpen`；`directorNodeId` 由 page 本地 state 持有。
- 不新增全局 store 切片承载纯 UI 开关；面板开关、右键菜单等瞬态状态留在 `CanvasRoot` / `CanvasOverlays` 的局部 state，除非现有 store 已承担该语义。canvas store 删除 `shortcutsVisible`、`directorOverlayOpen` 及对应 setter。

## VideoNode

- `VideoControls` 移入 `nodes/video/VideoControls.tsx`，保留现有 props 契约与 `memo` 行为。
- 上传、裁剪、截取片段、分离音频、下载、保存到资产库由 `use-video-node-actions.ts` 统一编排；节点组件只消费返回的 handler 与 busy/error 状态。
- `VideoNode.tsx` 不得直接导入 `@/features/canvas/api/file-api` 或 `@/features/canvas/editing/client-media/client-video`；这些调用只出现在 action hook 或其下层 service。
- 保存到资产库通过 `entities/asset` 公共命令完成，不导入 `features/assets` 内部 store/hook。
- 播放会话仍由现有 `useCanvasVideo` / `use-video-time-source` / `use-proxy-playback` 等 hook 承担，不重复实现。

## 业务规则

1. **行为等价**：拆分前后，节点/边变更、拖动、框选、缩放、吸附、编组、连线、批量接驳、文件拖入、快捷键、右键菜单、编辑面板、撤销/重做、自动保存、错误提示与现有 Spec 完全一致。
2. **单一装配点**：React Flow 回调只在 `CanvasSurface` 接线；根组件不再直接实现 `handleNodesChange`、`handleEdgesChange`、`handleConnect*`、`handleNodeDrag*`、文件拖放路由或媒体编辑 API 调用。
3. **实时状态**：从渲染闭包移入 hook 的事件处理器必须继续读取实时 store 状态；不得因拆分引入过期闭包。
4. **引用稳定**：新增 hook/组件的返回值与回调必须保持稳定；不得让 React Flow 的 `nodes` / `edges` / 回调 props 因根组件重渲染而产生额外提交。
5. **浮层边界**：动态面板继续使用现有 `next/dynamic` 懒加载；`CanvasOverlays` 不改变面板的挂载条件、位置、层级与关闭语义。
6. **模块契约**：按“模块契约与依赖”执行：canvas 不导入其它 feature；跨 feature 数据走 entities；跨 feature UI 走 page 注入的 ports/slots；公共入口只导出页面级 canvas 契约（`CanvasRoot`、会话/加载/保存/导演桥接 hook 与公开类型）；类型-only 导入同规则；禁止深导入、`export *` 与循环依赖。
7. **页面壳归属**：项目会话、资产弹窗内容、API 设置、快捷键、DirectorOverlay、退出/删除确认、会话过期由 page 持有；canvas 自有 Explorer/Agent/节点浮层由 `CanvasRoot` 持有；`CanvasRoot` 不接管页面壳；`AssetsDialog` 只有 `slots.assetsDialog` 一个挂载点。
8. **无死代码**：迁移后删除旧 handler、旧 import、旧注释、旧 store 字段与不再使用的测试 mock；禁止保留转发文件、兼容导出或双实现。
9. **命名**：根组件采用 `CanvasRoot`，不使用裸 `Canvas`（与 HTML `<canvas>`、现有 `Canvas*` 组件及画布领域词冲突）。`InfiniteCanvas` 名称随拆分退役；页面入口只从公共入口导入新路径。
10. **状态归属**：按“状态归属”表落位；页面壳开关不写入 canvas store；page 的页面壳变化不得触发 `CanvasSurface` 重挂或 ReactFlow 额外提交。
11. **会话生命周期**：三个 session 每个 surface 实例创建一次；项目切换/卸载 dispose；StrictMode 双挂载幂等；context 值稳定。
12. **性能护栏**：拆分前后，打开/关闭页面壳、拖动、框选、缩放不增加 ReactFlow 提交次数；拖动/框选/缩放期间不产生额外 `nodes`/`edges` 身份变化。验收以基线测量为准，不以“看起来不卡”为准。
13. **入口与 CSS**：页面只从 `features/canvas` 公共入口导入 `CanvasRoot`、`useCanvasSession`、`useSessionExpired`、`useDirectorBridge`、`preloadCanvasPromptTemplates`、`flushCanvasSave` 与公开类型；`@xyflow/react/dist/style.css` 只导入一次（page/layout 或 `CanvasSurface`，实现前二选一并固定）；新增客户端模块按需标注 `"use client"`。
14. **边界可执行**：跨 feature 规则必须由 lint/架构测试覆盖；新增 `features/canvas/index.ts`；仅文档约定不算完成。
15. **契约最小化**：`CanvasRoot` 的 props/ports/slots 只包含真实调用方需要的能力；不为“以后可能用”预留。entity 公共 API 不导出 store 对象、setter 或视觉组件。
16. **写通道与采纳顺序**：项目元数据写与画布保存的互斥、`adoptProject` 的拆分与顺序以 [web-module-contracts.md](web-module-contracts.md) 规则 1（项目写互斥与项目 API 拆分）、规则 3（`adoptProject` 拆分）为准；禁止第二把互斥锁，步骤之间不得 `await`、不得触发保存。

## 技术影响

- 新增 `features/canvas/root/*`、`features/canvas/index.ts`、`session/*`、`persistence/*`、`contexts/BatchConnectContext`、若干交互 hook、`nodes/video/*`、`entities/*` 公共入口、`components/media`、`components/model` 与 `components/layout/CanvasLoader`；`InfiniteCanvas.tsx` 与 `features/project/save-mutex.ts` 删除后退役。
- 修改 `web/src/app/(app)/canvas/[projectId]/page.tsx`、`web/src/app/(app)/project/page.tsx`（客户端组合根或客户端桥）、`nodes/canvas-node-types.ts`、`features/assets` 的 `AssetsDialog`/`asset-add`/`AssetCreateDialog`/`AssetInspector`/`AssetHoverPreview` 删除与替换、`features/settings`/`features/auth`/`features/project`/`features/director`/`features/model` 的 canvas 依赖、`providers/BatchConnectContext`、canvas store 的页面壳字段与输入闸门读取方（`use-canvas-keyboard`、截取/波形面板、Escape 关闭 hook）、`web/eslint.config.mjs`（或等价边界规则）、相关测试 mock 与注释中的 `InfiniteCanvas` 引用。
- `uploadMany` / `uploadOne` 迁入 `entities/asset`（公共契约见 [web-module-contracts.md](web-module-contracts.md) 规则 6.1（上传职责（Blob → 远程引用））、规则 6.2（逐项结果与错误分类）、规则 6.3（无画布副作用与 `uploadOne` 包装）），canvas 删除 raw sink 与 `uploadOne` 导出（规则 6.5（canvas 上传出口））；`expandAccept` 迁入 `lib/upload-formats`（规则 6.6（`expandAccept` 归属））；`clamp01` 迁入 `lib/utils/number`；`VideoPlayer` / `AudioWaveform` / `media-playback` / `useAudioWaveformInstance` 迁入 `components/media`；`AssetHoverPreview` 删除并泛化为 `components/media/MediaHoverPreview`，`MediaType` 上移 `src/types/media.ts`；`features/model` 纯 UI 迁入 `components/model`；`DirectorEntityMeta` 迁入 `entities/director`；`DirectorOverlay` 改公开 props，`DirectorNode` 改经 `useCanvasPorts().onOpenDirector(nodeId)` 上报；`save-manager` 改为直接读取 `canvas-document-store` 并订阅保存意图（规则 2），`canvas-store` 收敛为 React 适配层；canvas 新增 `CanvasInputGateContext` / `useCanvasInputBlocked()`；`ProjectListPage` 增加 `flushPendingCanvasSaves` prop；`entities/project` 新增 `runProjectWrite`、`getProjectRevision`。
- `@xyflow/react/dist/style.css` 的导入从 `InfiniteCanvas.tsx` 迁到唯一固定位置；新增 `"use client"` 模块必须逐一确认，不得把浏览器 API 依赖扩散到 server component。
- 不新增运行时依赖；若为边界检查引入 `dependency-cruiser` 等工具，只作为 devDependency，并单独说明。
- 测试基线：现有 canvas 测试全部通过；新增拆分模块的单元测试覆盖分支与错误路径；补 session 生命周期、StrictMode、Provider 归属、ports/slots 与跨 feature 导入检查；拖动/框选/缩放保留性能基线测量。
- 确认后同步更新 `web/AGENTS.md` 的前端分层说明；未确认前不修改规则文档。

## 异常与边界

| 场景 | 行为 |
| --- | --- |
| 拆分后 hook 在组件重渲染时重建回调 | 视为回归；必须保持回调身份稳定，避免 React Flow 额外提交 |
| 事件处理器持有旧 `nodes` / `selection` | 视为回归；必须读取实时 store，`stale-event-handler.test.ts` 必须通过 |
| 动态面板 chunk 加载失败 | 保持现有错误处理与重试语义，不新增兜底 |
| 节点在媒体编辑过程中卸载/切换项目 | 保持现有取消与清理语义；action hook 不得泄漏请求或状态 |
| 页面壳未挂载或 slot 缺失 | `CanvasSlots` 是必填契约；渲染方必须提供最小实现（测试可用空渲染 stub）。`CanvasRoot` 不得因 slot 缺失回退到导入其它 feature |
| page 的页面壳开关导致 `CanvasSurface` 重挂 | 视为回归；`CanvasSurface` 的挂载身份只由 projectId 决定 |
| `ReactFlowProvider` 重复或缺失 | 视为回归；页面入口唯一实例，`CanvasSurface` 与需要 RF context 的浮层必须在同一 provider 内 |
| StrictMode 双挂载后事件监听/rAF/DOM 样式残留 | 视为回归；session 的 attach/dispose 必须幂等，并有测试覆盖 |
| canvas 导入其它 feature 的 store/组件/hook | 视为边界违规；lint/架构检查失败，必须改 entity 公共 API 或 page 注入 |
| page 深导入 canvas 内部 | 视为边界违规；只允许公共入口 |
| `AssetsDialog` / `CanvasExplorer` 重新导入 canvas | 视为边界违规；资产插入走 slot 回调 |
| `ProjectToolbar` / `CanvasControls` 导入 auth/assets/project 等 feature 内部 | 视为边界违规；用户菜单走 slot，项目/用户数据走 entity |
| `features/assets/add-asset.ts` 继续导入 canvas | 视为边界违规；`createAssetNode` 迁入 canvas，`ASSET_DRAG_TYPE` 归 `entities/asset` |
| `AssetCreateDialog` 或 `AssetInspector` 仍导入 canvas `runMediaUpload` / `expandAccept` / `VideoPlayer` / `AudioWaveform` | 视为边界违规；批量上传走 `entities/asset.uploadMany`，`expandAccept` 走 `lib/upload-formats`，预览走 `components/media` |
| canvas `UploadSink` 保留 raw sink，或 `entities/asset` 复制节点上传管道 | 视为重复实现；raw 批量上传只归 entity，canvas 只保留占位节点/替换/派生语义 |
| `components/media/AudioWaveform` 导入 canvas 播放注册表/截取锁/`clip-range`，或硬编码 `nodrag` | 视为反向依赖；播放注册、截取锁与 `nodrag` 通过 props 注入，`clamp01` 走 `lib/utils/number` |
| `features/project` 仍持有画布会话/保存或导入 canvas | 视为边界违规；会话/保存迁入 canvas，`ProjectListPage` 只调用注入的 `flushPendingCanvasSaves` |
| canvas 或 `entities/project` 各建一把写互斥，或保留 `save-mutex.ts` | 视为回归；只允许 `entities/project.runProjectWrite` 单实例，改名/封面命令与 `save-manager` 共用 |
| `save-manager` 与 `canvas-store` 互相导入（含 `import type`），或引入 `CanvasSaveSource` 式运行期注册表 | 视为循环依赖或服务定位；保存器直接读取 `canvas-document-store` 并订阅保存意图，`canvas-store` 仅经保存器暴露 `flushAndWait` |
| canvas 读者仍自行组合 `modalOpen \|\| directorOverlayOpen`，或 page 把页面壳开关写入 canvas store | 视为状态归属违规；统一读 `useCanvasInputBlocked()`，页面壳只经 `inputBlocked` 传入 |
| `adoptProject` 在校验、摘要 upsert、文档采纳之间 `await`，或先写摘要再因载荷非法失败 | 视为回归；固定同步顺序，非法载荷返回 `rejected` 且不写任何状态 |
| `flushCanvasSave` reject 或无限等待 | 视为回归；单次等待 5s、整体截止 15s，始终 resolve，超时保留 dirty |
| Server Component 把 `flushCanvasSave` 函数 prop 直接传给 `ProjectListPage` | 构建/运行错误；项目路由壳改为客户端组件或经最小客户端桥注入 |
| 生成面板或 Agent 仍从 `@/features/model/*` 导入 | 视为边界违规；`features/model` 的纯 UI 与纯函数下沉 `components/model` |
| `MediaHoverPreview` 导入 `AssetItem` / canvas 类型，或 `features/assets` 保留 `AssetHoverPreview` 包装 | 视为层级违规；shared 只接收展示数据，`MediaType` 归 `src/types/media.ts`，资产侧删除包装 |
| `features/director` 或 `features/auth` 仍导入 canvas store/types/upload | 视为边界违规；导演类型走 `entities/director`，上传走 `entities/asset`，画布节点创建走 `useDirectorBridge` |
| `entities/project` 导出画布文档类型或保存编排 | 视为边界违规；画布文档归 `features/canvas`，entity 只保留项目摘要/列表/revision |
| `DirectorOverlay` 仍写 canvas store，或 page 与 canvas 各存一份 `directorNodeId` | 视为回归；page 唯一持有 `directorNodeId`，canvas 只经 `useCanvasPorts().onOpenDirector(nodeId)` 上报 |
| `AssetsDialog` 在 page 与 `slots.assetsDialog` 各挂载一次 | 视为回归；只允许 canvas 根内一个挂载点 |
| page 仍从 `features/canvas/shared` 导入 `CanvasLoader` 或 prompt 预设内部模块 | 视为边界违规；`CanvasLoader` 归 `components/layout`，prompt 预加载走公共 `preloadCanvasPromptTemplates` |
| `@xyflow/react/dist/style.css` 重复或丢失 | 视为回归；只允许一个固定导入点，并做页面视觉/样式验证 |
| 页面仍深导入 `InfiniteCanvas` 或缺失 `features/canvas/index.ts` | 视为未完成；页面只从公共入口导入页面级契约 |
| 拆分导致测试 mock 路径失效 | 更新 mock 到新模块；不得为通过测试保留旧路径导出 |
| 仅移动文件但未删除旧实现 | 视为未完成；禁止双实现并行 |
| 用事件总线/DI/全局单例替代 ports/slots | 拒绝；跨模块协作只走显式契约 |

## 验收标准

1. `CanvasRoot.tsx` 不再包含节点/边变更、连线判定、文件拖放路由、媒体编辑 API 调用等具体实现；相关逻辑位于对应 hook 或 session 接线模块。
2. `VideoNode.tsx` 不再直接导入 `file-api` / `client-video`；`VideoControls` 位于独立文件；上传、裁剪、截取、分离音频、下载、收藏均由 action hook 编排；收藏保存走 `entities/asset`。
3. `CanvasSurface` 是唯一直接接线 React Flow 回调的模块；`CanvasRoot` 只做 canvas 内部装配。
4. page 是唯一页面组合根：资产弹窗、API 设置、快捷键、DirectorOverlay、退出/删除确认、会话过期由 page 持有；`CanvasRoot` 不导入 auth/assets/project/settings；`providers` 不导入 canvas 内部。
5. `features/canvas/index.ts` 只导出页面级契约：`CanvasRoot` 与公开 props 类型、`useCanvasSession`、`useSessionExpired`、`useDirectorBridge`、`preloadCanvasPromptTemplates`、`flushCanvasSave`；不导出 store、内部 hook/组件。
6. `features/canvas` 无 feature→feature 导入；跨 feature 只走 `entities/*` 与 `components/media` / `components/model`；entities 相关范围无深导入、无 `export *`、无循环依赖；`module-boundaries` 架构测试在故意添加违规样例时失败。其它 feature 既有的非 canvas 跨 feature 依赖按 `specs/web-module-contracts.md` 的存量 ratchet 后续清理。
7. `entities/asset`、`entities/project`、`entities/user`、`entities/director` 只导出领域类型、读取 Hook/selector、命令与纯函数；不导出 store 对象、setter 或视觉组件；canvas 对它们的调用全部走公共 API。
8. `AssetsDialog`、`AssetBrowserPanel`、`ProjectToolbar`、`CanvasExplorer`、`CanvasControls` 通过 slots/ports 或 entity 契约工作：资产插入不导入 canvas，用户菜单不导入 auth UI，项目/用户数据不导入 feature store。
9. `stale-event-handler.test.ts`、现有 canvas 测试、web 架构边界测试全部通过。
10. 新增测试覆盖：节点/边变更分流、连线与批量接驳、文件拖放路由、面板挂载条件、VideoNode 媒体编辑成功/失败/取消路径、ports/slots 缺失与正常注入。
11. `cd web && npx tsc --noEmit`、`npm run lint`、`npx vitest run`（单 worker、串行）通过。
12. 手工走查（用户确认）：单选/多选/框选、拖动与吸附、编组/取消编组、连线与批量接驳、文件拖入、编辑面板开关、裁剪/截取/分离音频、撤销/重做、自动保存、明暗主题。
13. 无新增 `any`、`eslint-disable`、兼容导出或死代码。
14. 状态归属符合“状态归属”表：页面壳开关（含 `settingsOpen`）不写入 canvas store，store 删除 `shortcutsVisible` / `directorOverlayOpen`，`ApiSettingsDrawer` 不再导入 canvas store；page 持有开关并向 canvas 传递 `inputBlocked`，canvas 经 `useCanvasInputBlocked()` 暴露 `inputBlocked || modalOpen`，快捷键、截取/波形面板与 Escape 关闭 hook 只读该值；`CanvasRoot` 页面壳变化不触发 `CanvasSurface` 重挂；不存在同一状态在 page/root/surface/store 各存一份。
15. Provider 归属符合“Provider 树与会话生命周期”：`ReactFlowProvider` 唯一；`CanvasPortsContext` / `CanvasInputGateContext` / `CanvasShellContext` 由 `CanvasRoot` 持有且值稳定；`CanvasMediaLoadingProvider key={projectId}` 在 `CanvasSurface` 外层；`BatchConnectContext` / `ResizeSessionContext` 由 `CanvasSurface` 持有并包住 ReactFlow；三个 session 在项目切换/卸载时 dispose，StrictMode 双挂载无残留；context 值稳定；不存在为兼容旧顺序而复制 context 或新增表外 provider。
16. `@xyflow/react/dist/style.css` 只有一个固定导入点；新增模块的 `"use client"` 标注经过核对，构建与页面样式正常。
17. 性能护栏通过：与基线相比，页面壳开关、拖动、框选、缩放不增加 ReactFlow 提交次数；拖动/框选/缩放期间无额外 `nodes`/`edges` 身份变化；基线测量方法与结果记录在实现说明中。
18. 画布文档归属正确：`use-canvas-session`、`save-manager`、`canvas-lease`、`session-expired-store` 与画布文档类型位于 `features/canvas`；`features/project/save-mutex.ts` 已删除，写互斥与 `adoptProject` 拆分符合 [web-module-contracts.md](web-module-contracts.md) 规则 1（项目写互斥与项目 API 拆分）、规则 3（`adoptProject` 拆分）；`features/project` 无 canvas 导入；`ProjectListPage` 只调用注入的 `flushPendingCanvasSaves`，`app/(app)/project/page.tsx` 作为 `"use client"` 组合根或经最小客户端桥注入 `flushCanvasSave`（Server Component 不传函数 prop）。
19. 导演与上传边界正确：`DirectorOverlay` 只接收 `initialState` / `onSaveState` / `onCreateImageNode` / `onClose`，不导入 canvas；page 通过 `useDirectorBridge(directorNodeId)` 提供 `initialState` / `onSaveState` / `onCreateImageNode`，关闭顺序为“captureState → onSaveState → reset → page onClose”；`DirectorNode` 只通过 `useCanvasPorts().onOpenDirector(nodeId)` 上报；`uploadOne` 位于 `entities/asset`，auth 与 director 均不导入 canvas；director store 不再保留 `openingNodeId` / `restoreState` 及对应 setter（`DirectorRuntime.restoreState` 是 Three.js 运行时接口方法，不属于被删除的 store 字段/setter），`DirectorNodeData` 留在 canvas；`directorNodeId` 为空或节点不存在时 `onSaveState` / `onCreateImageNode` 为 no-op。
20. 页面加载与挂载边界正确：page 从 `components/layout/CanvasLoader` 渲染加载门；设置门并行等待模型库、资产库与 `preloadCanvasPromptTemplates(queryClient)`；模型库/资产库在 `initialize()` settle 后读取 `initialized`，`preloadCanvasPromptTemplates` 仅在“刷新成功或刷新失败但已有缓存数据”时返回 `true`、无可用数据时返回 `false`，三者全真才 ready，其余失败进入 `failed` 并允许重试；`flushCanvasSave` 单次等待 5s、整体截止 15s、始终 resolve；`AssetsDialog` 只在 `slots.assetsDialog` 挂载一次，slot api 只含 `onInsertAsset` / `onInsertAssets`，开关由 page 闭包绑定；page 不导入 canvas store、内部 hook、prompt 预设内部模块或 `InfiniteCanvas`。
21. 共享层边界正确：`features/media` 与 `features/model` 迁移后无残留路径与重复实现；`components/media` / `components/model` 不反向导入 feature/entity；`components/media` 承接 `VideoPlayer` / `AudioWaveform` / `media-playback` / `useAudioWaveformInstance`，画布注册、截取锁与 `nodrag` 只经 props 注入，`clamp01` 来自 `lib/utils/number` 而非 canvas `clip-range`；`clamp01` 只有一份实现，canvas `clip-range` 与 shared 共用；`AssetHoverPreview` 删除并泛化为 `components/media/MediaHoverPreview`，props 只含 `{ name; mediaType; fileKey?; plainText?; enabled?; children }`，`MediaType` 来自 `src/types/media.ts`，不导入 `AssetItem` 或 canvas 类型。
22. `entities/asset` 的 `uploadMany` / `uploadOne` 符合 [web-module-contracts.md](web-module-contracts.md) 规则 6.1（上传职责（Blob → 远程引用））、规则 6.2（逐项结果与错误分类）、规则 6.3（无画布副作用与 `uploadOne` 包装）；`AssetCreateDialog` 与 `expandAccept` 符合规则 6.4（调用方前置校验）、规则 6.6（`expandAccept` 归属）；canvas `runMediaUpload` 符合规则 6.5（canvas 上传出口），不存在两份底层上传实现。
23. `CanvasPorts` / `CanvasSlots` 全部必填，page 以模块级函数或 `useCallback` / `useMemo` 提供稳定引用；缺失能力用显式 no-op 或 `() => null` 实现，不存在可选属性或 `?.` 兜底；`slots.assetsDialog` 因 page 闭包捕获 `assetsOpen` 是稳定引用规则的唯一例外，`CanvasRoot` 不把它传给 `CanvasSurface`、不写入 effect 依赖，slot api 对象保持 `useMemo` 稳定；page 的页面壳状态变化不引起 `CanvasSurface` 重挂。`ports` 由 `CanvasRoot` 经 `CanvasPortsContext` 下发，`CanvasSurface` 不接收 `ports` prop。
24. `ASSET_DRAG_TYPE` 只存在于 `entities/asset`，值为 `"application/x-asset"`；assets 与 canvas 的拖放实现均从 entity 导入，不存在第二份常量。
25. `features/assets` 无任何 canvas 导入：`AssetCreateDialog` 走 entity raw 批量上传，`AssetInspector` 走 `components/media`，`AssetsDialog` / `AssetBrowserPanel` 走注入回调与 `ASSET_DRAG_TYPE`；`AssetHoverPreview` 包装已删除，资产卡片直接使用 `components/media/MediaHoverPreview`。
26. 保存与输入闸门契约正确：保存依赖满足 [web-module-contracts.md](web-module-contracts.md) 规则 2（画布文档与保存的静态分层）——`canvas-document-store` 是叶子，`save-manager` 直接读取快照 / 所有者 / `agentModel` 并订阅保存意图，`canvas-store` 仅经保存器暴露 `flushAndWait`；不存在 `CanvasSaveSource` 注册表、注册副作用导入或未注册抛错；文件级依赖图（含 `import type`）无环；`CanvasSlots.assetsDialog` 只携带 `onInsertAsset` / `onInsertAssets`，`open` / `onOpenChange` 由 page 闭包绑定，`AssetsDialog` 只经该 slot 挂载一次；`nodeTypes` / `edgeTypes` 在模块级稳定，`DirectorNode` 经 `useCanvasPorts()` 读取 `onOpenDirector`。

## 已确认事项

通用分层、公共 API、边界工具与存量 ratchet 的确认见 `specs/web-module-contracts.md`。本 Spec 需确认的 canvas 落地项：

2026-11-04 用户确认本 Spec 及以下全部 canvas 落地事项（1–12）；原问句保留为决策记录。

1. **页面壳归属**：是否确认 `assetsOpen`、`settingsOpen`、`shortcutsVisible`、`directorNodeId`、退出/删除确认、会话过期由 page 持有；`CanvasRoot` 只保留 Explorer/Agent/节点浮层；page 以 `inputBlocked` 向 canvas 传递输入阻断，canvas 内部经 `CanvasInputGateContext` / `useCanvasInputBlocked()` 合并 `inputBlocked || modalOpen`，并从 store 删除 `shortcutsVisible` / `directorOverlayOpen`？
2. **ports/slots 契约**：是否确认 `CanvasPorts` 为 `onOpenAssets` / `onOpenSettings` / `onOpenShortcuts` / `onOpenDirector(nodeId)`，由 `CanvasRoot` 经 `CanvasPortsContext` 下发（`CanvasSurface` 不再接收 `ports` prop）；`CanvasSlots` 为 `userMenu`、`assetBrowser`、`assetsDialog`（后两者以 render slot 把 canvas 插入动作交给 feature UI，`assetsDialog` api 为 `{ onInsertAsset; onInsertAssets }`，开关由 page 闭包绑定）？
3. **资产边界**：是否确认 `AssetsDialog` 改为接收 `open` / `onOpenChange` / `onInsertAsset` / `onInsertAssets`，把 `CanvasExplorer` 现有资产快捷访问区原样抽为 `AssetBrowserPanel`（不新写浏览逻辑），`AssetCreateDialog` 改用 `entities/asset.uploadMany`，`AssetInspector` 改用 `components/media`，`createAssetNode` 迁入 canvas，`ASSET_DRAG_TYPE` 归 `entities/asset`，`features/assets` 不再导入 canvas？
4. **前置迁移**：是否确认本期先完成 `entities/asset|project|user|director`、`uploadMany` / `uploadOne → entities/asset`、`features/media` 与 canvas 通用媒体组件 → `components/media`、`features/model → components/model`（`AssetHoverPreview` 泛化为 `components/media/MediaHoverPreview`，`MediaType` 上移 `src/types/media.ts`），再拆 canvas 内部；`task` 暂不独立成 entity？
5. **范围**：是否确认 `VideoNode` 拆分仍在本 Spec 内，不另立 Spec？
6. **边界检查**：是否接受复用 `eslint-plugin-boundaries` + TypeScript AST 架构测试 + 存量 ratchet；canvas/entities 相关项在本期清零，其它 feature 的存量项后续逐步清理？
7. **画布文档与写互斥归属**：是否确认 `use-canvas-session`、`save-manager`、`canvas-lease`、`session-expired-store` 与画布文档类型从 `features/project` 迁入 `features/canvas`；项目写互斥留在 `entities/project` 并以 `runProjectWrite` 暴露，`save-mutex.ts` 删除，项目命令与 `save-manager` 共用；`entities/project` 只保留摘要/列表/`activeProjectId`/revision/命令；`ProjectListPage` 由 app 注入 flush？
8. **导演与上传边界**：是否确认 `DirectorOverlay` 改为公开 props、page 用 `useDirectorBridge(directorNodeId)` 桥接、`DirectorNode` 只经 `useCanvasPorts().onOpenDirector(nodeId)` 上报；`uploadMany` / `uploadOne` 从 canvas 迁入 `entities/asset`，canvas 删除 raw sink？
9. **加载门与预加载**：是否确认 `CanvasLoader` 迁入 `components/layout`，提示词目录预加载收敛为 canvas 公共 `preloadCanvasPromptTemplates(queryClient)`，页面不再导入 canvas shared 内部？
10. **模型 UI 下沉**：是否确认 `features/model` 的 `ModelSelector` / `ModelParamFields` / `ModelIcon` / `param-fields` 下沉 `components/model`，模型库状态仍在 `lib/model-store`，本期不迁 `entities/model`？
11. **资产原始上传与共享音频**：是否确认 `entities/asset` 提供 `uploadMany` / `uploadOne` 原始上传契约并删除 canvas raw sink，`expandAccept` 迁入 `lib/upload-formats`，`components/media` 承接 `VideoPlayer` / `AudioWaveform` / `media-playback` / `useAudioWaveformInstance`，画布注册/截取锁/`nodrag` 由 props 注入？（契约正文以 `web-module-contracts.md` 规则 6.1（上传职责（Blob → 远程引用））至规则 6.6（`expandAccept` 归属）为准；本条仅保留决策记录。）
12. **保存依赖倒置与输入闸门**：是否确认 `save-manager` 删除对 `canvas-store` 的导入，改为 `CanvasSaveSource`（`getProjectId` / `takeSnapshot` / `getAgentModel`）+ `attachCanvasSaveSource`，由 `features/canvas` 模块初始化时注册（`CanvasRoot` 挂载晚于会话握手内的保存基线建立，不能作为注册点），未注册调用保存直接抛错；`revision` 读取改走 `entities/project.getProjectRevision`，租约/会话过期迁入 canvas；`CanvasInputGateContext` 合并 `inputBlocked || modalOpen` 并以 `useCanvasInputBlocked()` 暴露？
    - 2026-11-09 保存部分已被 [web-module-contracts.md](web-module-contracts.md) 规则 2（画布文档与保存的静态分层）取代：删除 `CanvasSaveSource` 注册表，改为文档 store 叶子 + 有界保存意图 + React 适配层；输入闸门部分不变。本条保留为决策历史。

## 当前状态

- 2026-11-04：完成现状盘点与目标结构起草；本 Spec 为待确认，尚未修改任何业务代码。
- 2026-11-04：按评审意见补录跨 feature 现状、状态归属、Provider/会话生命周期、迁移顺序、性能与边界验收；当前仍为待确认。
- 2026-11-04：根据用户“按模块契约架构调整”的决策，移除方案 A/B，改为 `app → features → entities → shared`；页面壳上移 page，canvas 通过 ports/slots 注入跨 feature UI；通用规则见 `specs/web-module-contracts.md`。
- 2026-11-04：按模块契约完成一致性修订：画布会话/保存/文档类型归 canvas，project 只保留摘要/列表/激活/revision；补齐 `CanvasLoader`、prompt 预加载、`useDirectorBridge`、`uploadOne`、`AssetHoverPreview`、`BatchConnectContext` 的落位与验收项。
- 2026-11-04：二次修订：项目写互斥归 `entities/project.runProjectWrite`（与项目元数据写共用，禁止第二把锁）；`AssetHoverPreview` 留在 assets（四次修订已改判），仅 `features/media` 与 `features/model` 下沉；补齐 `useDirectorBridge` 签名与关闭顺序、设置门、`flushCanvasSave` 5s/15s 语义、`ASSET_DRAG_TYPE` 与 ports/slots 稳定性验收；明确 `DirectorNodeData` 留在 canvas，删除 director store 的 `openingNodeId` / `restoreState` 兼容字段。
- 2026-11-04：三次修订：补齐 `features/assets` 的 canvas 反向依赖缺口——`uploadMany` / `uploadOne` 迁入 `entities/asset` 并删除 canvas raw sink，`expandAccept` 迁入 `lib/upload-formats`，`components/media` 承接 canvas `VideoPlayer` / `AudioWaveform` / `media-playback` / `useAudioWaveformInstance`；新增验收 25 与待确认事项 11。
- 2026-11-04 交叉核对：补齐与 `specs/web-module-contracts.md` 的一致性——`uploadMany` 逐项 outcome 非空约束与 `offline` / `unsupported` 分类、`uploadOne` 单文件包装与 `notify` 走共享 `showGlobalMessage`；`clamp01` 下沉 `lib/utils/number` 并同步验收 21 与异常表；`features/settings/ApiSettingsDrawer` 的 canvas store 依赖归 page 的 `settingsOpen` / `inputBlocked`，同步验收 14；验收 22 改写为逐项结果契约，不再表述为“与现实现一致”。
- 2026-11-04 四次修订：按审核结论修正——`save-manager` 与 `canvas-store` 循环依赖改为 `CanvasSaveSource` 注册式倒置（`canvas-store → save-manager` 单向）；输入闸门落为 `CanvasInputGateContext` / `useCanvasInputBlocked()`，store 删除 `shortcutsVisible` / `directorOverlayOpen`；`CanvasSlots.assetsDialog` 增加 `open` / `onOpenChange`；补齐 `useCanvasSession` / `useSessionExpired` / `preloadCanvasPromptTemplates` / `flushCanvasSave` 签名；`AssetHoverPreview` 改判为泛化 `components/media/MediaHoverPreview` 并删除 assets 包装；`DirectorEntityMeta` 迁入 `entities/director`；`AssetBrowserPanel` 明确为现有资产快捷访问区原样抽取。新增验收 26 与待确认事项 12。
- 2026-11-04 五次修订：依据二次审核结论修正——`CanvasSaveSource` 注册改到 `features/canvas` 模块初始化（`CanvasRoot` 挂载晚于 `useCanvasSession` 握手，不能作为注册点）；`CanvasSlots.assetsDialog` api 收敛为 `{ onInsertAsset; onInsertAssets }`，`open` / `onOpenChange` 由 page 闭包绑定，并列为稳定引用规则的唯一例外；新增 `CanvasPortsContext` 统一下发 `ports`，`CanvasSurface` 不再接收 `ports` prop；`nodeTypes` / `edgeTypes` 改为模块级稳定常量，`DirectorNode` 经 `useCanvasPorts()` 读取 `onOpenDirector`；`AssetsDialog` 现状 props 更正为 `open` / `onClose` 并明确改造方向；`AssetBrowserPanel` 保留 `ASSET_DRAG_TYPE` 拖拽路径；`preloadCanvasPromptTemplates` 明确“刷新失败但已有缓存仍返回 `true`”。同步更新验收 19、20、23、26 与待确认 2、8、12。
- 2026-11-04 六次修订：依据审核结论修正——设置门改为两个 store 的 `initialize()` settle 后读取 `initialized`，再与 `preloadCanvasPromptTemplates` 的布尔结果取全真；保存注册表述统一为“模块初始化，不依赖 `CanvasRoot` 挂载”；状态归属表补充用户菜单开关；持久化目录补充 `canvas-save-source.ts`。
- 2026-11-04 用户确认本 Spec（含上述十二项 canvas 落地事项）；确认范围为业务规则、接口契约与技术方案，不含数据库变更、生产部署、提交或推送授权；状态改为「已确认」。尚未开始实现，未执行测试。
- 2026-11-04 实施完成（工作区未提交）：按「迁移顺序」完成第 1–9 步。第 7 步将浮层拆为 `root/overlays/NodeOverlays.tsx`（节点级）与 `root/overlays/GlobalOverlays.tsx`（画布级），`CanvasOverlays` 只做编排，`next/dynamic` 懒加载与挂载条件保持不变；第 8 步将 React Flow 接线、DragPreview / Marquee / Resize 三个会话、`BatchConnectContext` / `ResizeSessionContext` 与控件渲染收敛到 `CanvasSurface`，浮层作为两个会话 Provider 内的兄弟节点，经页面层 `ReactFlowProvider` 的 portal 渲染；第 9 步收紧 `features/canvas/index.ts` 公共 barrel、清除 `InfiniteCanvas` 全部引用，`module-boundaries.baseline.json` 的 canvas/entities 条目清零（仅剩 2 条既有非 canvas 项，无循环）。验证：`npx tsc --noEmit` 通过；`npx eslint src` 0 error（6 个既有 `<img>` warning）；web `npx vitest run --maxWorkers=1 --minWorkers=1` 199 文件 / 1591 测试通过；server 同参数 106 文件通过 + 3 文件跳过（1251 通过 / 14 跳过）。未验证：真实浏览器走查（页面壳开合、项目切换、StrictMode 双挂载、拖动/框选/缩放的提交次数与长任务基线）未执行；实现代码未提交。状态保持「已确认」，待用户走查确认并授权提交后方可改为「已实现」。
- 2026-11-05 浏览器走查（自动化；headless Chrome + React DevTools commit hook + PerformanceObserver，非用户手工走查）：覆盖注册、建项目、建文本节点、自动保存、刷新与跨路由恢复、SPA 项目切换、撤销/重做、明暗主题、页面壳（设置/资产库/快捷键）开合、拖动、框选、缩放。干净加载基线 19 次 root commit、1 个 `.react-flow__renderer`；拖动 6 次 commit（1 次 `nodes` 身份变化）、框选 3 次（1 次）、缩放 4 次（0 次），均无 longtask；空闲 1.2s 内 0 commit。SPA 项目切换 27 次 commit（1 次 88ms longtask），旧 React Flow 实例脱离 DOM，新页面仅 1 个 renderer；返回 Project 1 后节点变换与视口保持。
- 2026-11-05 走查发现并根因修复：页面壳开合会让 `CanvasSurface` 随 `CanvasRoot` 重渲染（每次开合 3–6 次 commit），与「页面壳状态只经输入门送达叶组件」的设计不符；根因是 `CanvasSurface` 未 `memo`，而其唯一 prop `slots` 引用稳定。改为 `export default memo(CanvasSurface)`。修复后以临时渲染计数（已移除）验证：设置/资产库/快捷键各阶段 `CanvasSurface` 渲染次数保持不变（8），`CanvasKeyboardBridge` 每次输入门变化 +2（StrictMode 双调用同一次渲染），即只重渲染叶组件；`nodes`/`edges` 身份变化 0、renderer 恒为 1、无重挂、无 console/page error。资产库打开仍有 62–72ms longtask，属弹窗自身渲染，不来自画布提交。
- 2026-11-05 验证：`npx tsc --noEmit` 通过；`npx eslint src` 0 error（6 个既有 `<img>` warning）；web `npx vitest run --maxWorkers=1 --minWorkers=1` 199 文件 / 1591 测试通过。未覆盖：文件拖入、连线/批量接驳、编组/取消编组、编辑面板语义（点击节点「编辑」未出现 dialog/sheet/textarea，疑似行内编辑，未判定）、StrictMode 双 effect 的直接计数、验收 12 的用户手工走查。实现代码仍未提交，状态保持「已确认」。
- 2026-11-05 根因修复（工作区未提交）：项目列表自定义封面改走 `entities/asset.uploadMany`（离线/不支持类型/体积超限的前置校验与逐项 outcome 统一由 entity 承担），页面只提交返回的 key 并展示错误，删除对 `lib/utils/upload` 的直接依赖，新增成功与前置校验失败的回归测试；`CanvasSlots.userMenu.trigger` 契约更正为 `React.ReactElement`（Radix `DropdownMenuTrigger asChild` 要求单一元素）；补齐画布路由测试：原子握手首帧（全量快照 + 租约令牌）、握手完成后才驱逐他人、同 sid 重连不轮换租约、superseded 只补发 evict、连接前 404 与缺失 sid 422，以及 `CanvasCoverKeyError` → 422 映射。
- 2026-11-05 边界清理（工作区未提交）：`module-boundaries.baseline.json` 的违规与循环条目全部清零——`ProjectListPage` 不再包裹 `AppShell`（页面壳由 `app/(app)/project/page.tsx` 组合），`features/settings` 删除 `modelApi` 转发；canvas 专用 `OfflineIndicator` 由 app 层 `components/layout` 移入 `features/canvas/root/`（2026-11-14 更正：原记录误写为 `components/ui`；该文件后于 `e3e4ec82` 删除，保存状态展示改由 `CanvasSaveStatusIndicator` 承担，见 [canvas-save-status.md](canvas-save-status.md)），共享 `AudioWaveform` 的句柄类型统一为 `AudioPlayerHandle`。状态保持「已确认」，实现代码未提交（后随 `a2f521c0` 提交）。
- 2026-11-06 文档校正（工作区未提交）：Provider 树补入 `CanvasInputGateContext` / `CanvasShellContext`，与 `CanvasRoot` 实际装配一致；明确 `CanvasShellContext` 承载 `explorerOpen` 与稳定的 `toggleExplorer` / `openAgent`，页面壳状态权威仍在 page；`CanvasSurface` 的 React Flow `colorMode` 经 shared `components/ui/theme-mode` 的 `useThemeMode()` 读取，Provider 由 app 组合根挂载；验收 15 同步为三个 canvas context，并将“不得用额外 provider”收敛为“不得新增表外 provider”。状态保持「已确认」，实现代码未提交。
- 2026-11-06 契约清理（工作区未提交）：`CanvasSurfaceSlots` 收窄为 `Pick<CanvasSlots, "userMenu">`——`CanvasRoot` 不再把无消费方的 `assetBrowser` 透传给 `CanvasSurface`，`assetBrowser` 仍直接下发给 `CanvasExplorer`，`assetsDialog` 仍由 `CanvasRoot` 单独挂载；运行时契约测试改为断言 `CanvasSurface` 只收到 `userMenu`、不含 `assetBrowser` / `assetsDialog`。同时把派生节点的“节点 + 源连线”提交抽为 `features/canvas/upload` 的 `commitDerivedNodes`，替换上传管道与视频编辑动作中的 5 处重复批次，并补充节点/边同批写入的单元测试。验证：`npx tsc --noEmit` 通过；`npm run lint` 0 error（6 个既有 `<img>` warning）；`CanvasRoot.contract`、`derived-node-commit` 与 `VideoNode` 相关测试通过。状态保持「已确认」，实现代码未提交。
- 2026-11-06 互斥边界澄清（仅文档，代码未改动）：`entities/project.runProjectWrite` 只串行化携带 `revision` / 租约的写（画布保存、项目改名、封面）；创建/删除不经过互斥，删除的现有调用点都在删除前 `await flushCanvasSave()`，画布页流程见 `handleDeleteProject`。状态保持「已确认」，实现代码未提交。
- 2026-11-08 保存截止时间收敛（工作区未提交）：`save-manager.flushAndWait` 的每次 `withTimeout` 取 `min(5s, deadline - Date.now())`，同时满足「单次等待上限 5s、整体截止 15s」；原实现「等在途保存 5s + 补存 5s」的循环在边界处可把总耗时推到约 20s，仅按剩余预算则单次等待可长达 15s。超时仍保留 dirty 并放行调用方。验证：`save-manager` 相关 4 文件 / 28 用例通过（新增「单次 5s、整体 15s」回归）；typecheck / lint 通过；全量 web 207 文件 / 1644 passed；全量 server 108 文件 / 1286 passed（3 文件跳过，14 用例跳过）。
- 2026-11-08 引用收口（工作区未提交）：其他 Spec 中仍把 `InfiniteCanvas.tsx` 当作现状的实现段改为 `root/CanvasSurface.tsx` / `root/overlays/GlobalOverlays.tsx` / `hooks/use-canvas-node-changes.ts`（`canvas-flow-layer.md`、`canvas-resize-gesture-session.md`、`canvas-multi-selection-toolbar.md`、`canvas-snap-alignment.md`、`canvas-selection-chrome-scheduling.md`、`canvas-media-resolution-lod.md`、`canvas-marquee-gesture-session.md`、`canvas-drag-preview-session.md`）；带日期的调查/当前状态记录保留原样，作为拆分前快照。
- 2026-11-08 评审修复与回归补齐（工作区未提交）：
  - `save-manager` 401 根因修复：401 原先按成功返回（`saveToApi` 提前 return），`save()` 随后清 dirty、不重排保存；`flushOnHide` / `flushOnUnload` 的 `skipUnauthorized` 路径又不触发全局失效，未落库改动会静默丢失。现 401 抛 `SaveUnauthorizedError`，保留 dirty、置 `authBlocked` 暂停自动重试并清 `pendingSave`；下一次编辑、显式 `flushAndWait`、`flushOnHide` / `flushOnUnload` 或重新握手解除阻断并按原 `baseRevision` 重试，409 仍专属租约失效。回归用例覆盖「下一次编辑」「`flushOnHide`」「`flushOnUnload`」「`flushAndWait` 重试」「握手恢复」5 条恢复路径。
  - 回归补齐：`use-file-drop` 测试改为驱动生产 hook（原测试在本地重写实现，生产 hook 无覆盖），覆盖文件/资产/引用拖拽与 dragover；新增 `create-nodes-from-files`（网格排布、音视频与不支持类型透传、空列表、离线）与 `use-batch-connect-drag`（扇出/扇入/空白落点/4px 阈值/参与者命中/pointercancel/重入）用例。
  - 文档收口：`entities/asset` 上传契约的重复正文改为引用 `specs/web-module-contracts.md` 规则 6.1–6.6（含规则标题），本 Spec 验收 22、验收 5 与技术影响同步改为引用式。
  - 验证（已验证事实）：`npm run typecheck`、`npm run lint`（0 error，6 个既有 warning）通过；定向 7 文件 / 48 用例、web 全量 209 文件 / 1655 用例通过；server 全量 108 文件 / 1286 用例通过（3 文件跳过、14 用例跳过）。首次 server 全量的 5 文件 hook 超时为测试库残留孤儿会话（一条超时 UPDATE 持行锁 → TRUNCATE 等锁 → advisory lock 排队），清理后复跑通过，非代码回归。状态保持「已确认」，实现代码未提交。
- 2026-11-08 评审修复（工作区未提交）：`createProject` 失败改由 `entities/project` 统一提示并返回 `null`，画布页与项目列表页收到 `null` 不导航；`createImageNodeFromRef` / `createAudioNodeFromRef` / `createVideoNodeFromRef` 改用参数对象收敛长参数列表；`canvas-group-layout.md` 与 `canvas-undo-redo-integrity.md` 的过期 `InfiniteCanvas.tsx` 引用已校正；401 恢复回归补齐 `flushOnUnload`、`flushAndWait` 重试与握手恢复。验证：`npm run typecheck` 通过；`npm run lint` 0 error（6 个既有 `<img>` warning）；web 全量 209 文件 / 1663 用例、server 全量 108 文件 / 1286 用例通过（3 文件跳过、14 用例跳过）。状态保持「已确认」，实现代码未提交。
- 2026-11-08 引用收口（仅文档）：`runProjectWrite`、`CanvasSaveSource`、`adoptProject` 的重复正文改为引用 [web-module-contracts.md](web-module-contracts.md) 规则 1（项目写互斥与项目 API 拆分）、规则 2（画布文档与保存的静态分层；2026-11-08 当时称「画布保存依赖倒置」）、规则 3（`adoptProject` 拆分）；`entities/asset` 上传契约引用改为规则 6.1–6.6；本 Spec 只保留 canvas 落位、状态归属与验收，规则语义未变。状态保持「已确认」，实现代码未提交（后随 `a2f521c0` 提交）。
- 2026-11-09 保存架构根因修订（工作区未提交）：按 [web-module-contracts.md](web-module-contracts.md) 规则 2（画布文档与保存的静态分层）更新落位与验收 26——`canvas-document-store` 为叶子，`save-intent` 为有界意图信号，`save-manager` 直接读取文档并订阅意图，`canvas-store` 收敛为 React 适配层；删除 `canvas-save-source.ts` / `canvas-save-registration.ts` 及公共入口副作用导入。经用户授权调整核心架构。实现完成并通过验证：`npm run typecheck`、`npm run lint`（0 error，6 个既有 `<img>` warning）、server 全量 109 文件 / 1287 passed / 14 skipped、web 全量 211 文件 / 1676 passed（含新增 `save-intent` 与 `canvas-save-layering` 用例），web 架构边界测试确认文件级依赖图无环。浏览器运行时走查未执行（本机预览 attach 不可用，未另起第二套开发栈）。状态保持「已确认」，代码未提交；「已实现」待用户确认提交后设置。
- 2026-11-09 引用补正（仅文档）：`canvas-marquee-gesture-session.md`、`canvas-resize-gesture-session.md` 中仍把 `InfiniteCanvas.tsx` 当作现状/可复用件的 3 处引用改为 `root/CanvasSurface.tsx` / `hooks/use-canvas-node-changes.ts`；带日期的调查与当前状态记录继续保持拆分前快照。
- 2026-11-14 提交事实与 HEAD 收口复验（自动化走查，非用户手工走查）：
  - 提交事实：本 Spec 的实现与文档已随 `a2f521c0`（2026-11-09 23:43，`refactor(repo): 收敛服务与前端模块边界并修复删除/拖拽回归`，400 文件混合提交）提交。上方 2026-11-04 至 2026-11-09 各条中的「工作区未提交 / 实现代码未提交」均为提交前状态，不再代表当前状态。后续画布相关提交（`ce08456f` 点阵/连线视觉、`a6efc1dd` 剪贴板、`8a8eb1fb` / `ea0083d9` / `416e3ea5` / `539710f3` 编辑面板指针会话、`d813a1d0` 点阵/批量连线测试、`e3e4ec82` 保存状态指示器与 `CanvasRoot.setUnloadPromptEligible`、`c6dc9c6f` 边界扫描扩展）各有独立 Spec，不属于本 Spec 拆分目标的验收范围。收口时 HEAD 为 `6f5a81cf`，工作区干净。
  - 验收 9/11（HEAD 串行复验）：`cd web && npx tsc --noEmit` 通过；`npm run lint` 0 error（6 个既有 `<img>` warning）；web Vitest 226 文件 / 1841 用例通过（单 worker、串行）；架构测试 9/9 通过（`module-boundaries.baseline.json` violations=[]、cycles=[]）；`npm run build` 通过。本 Spec 验收只要求 web 侧命令；server 全量未在本轮重跑。
  - 验收 17（HEAD 浏览器复测）：headless Chrome + 临时 React DevTools commit hook + PerformanceObserver，dev 构建，2 个文本节点；拖动前先单击选中节点，8 步拖动（每步 16ms）。空闲 1.2s 0 commit；页面壳设置 15 / 资产库 14 / 快捷键 20 commit，三者 nodes/edges 身份变化均 0、renderer 恒为 1 且为同一 DOM 节点、2 个节点 DOM 节点不重建；资产库打开 67–76ms longtask（弹窗自身渲染，与 2026-11-05 记录的 62–72ms 同类），其余阶段无 longtask。拖动 10 commit、nodes 身份变化 1、edges 0、无 longtask；框选 7 commit、nodes 身份变化 2（选择态）、edges 0、无 longtask，命中 2 节点；缩放 4 commit、0 身份变化、无 longtask（scale 1 → 1.39474）。与 2026-11-05 记录（拖动 6 / 框选 3 / 缩放 4，身份变化 1/1/0）相比：缩放一致；拖动 ReactFlow props 身份变化 1 次、与基线一致，root commit 总数 10 高于基线 6——已验证 9/10 次 commit 未改变 ReactFlow props，具体归属组件未逐项采样（推测为选择 chrome / 拖动预览会话等画布交互组件），当时的走查脚本未留档，无法同口径拆分；框选 props 身份变化 2 次、高于基线 1 次（具体触发点未逐项采样），edges 无变化；所有阶段无重挂、无 longtask。按护栏意图（页面壳开合不引起画布提交、交互不产生额外 nodes/edges 抖动）判定通过，root commit 与 ReactFlow props 身份变化的差异一并记录。
  - 自动保存与 SPA 项目切换（同一走查）：编辑后 `PUT /api/canvas/projects/:id` 4 次均 200；A → 项目列表 → B 与 B → 列表 → A 均为 SPA 切换（页面 marker 保持），切换后 renderer 恒为 1、旧实例 `isConnected === false`；B 为空项目，返回 A 后 2 个节点与缩放视口（1.39474）恢复；两次切换各 1 次 longtask（74–105ms / 95–97ms，多轮波动，路由与会话握手阶段），与 2026-11-05 的 88ms 同类。
  - 验收 12（用户手工走查）仍未确认：本轮为自动化走查，未覆盖文件拖入、连线/批量接驳、编组/取消编组、裁剪/截取/分离音频、编辑面板、撤销/重做、明暗主题。验收 10 的 hook 级/挂载条件/取消路径覆盖缺口与验收 15 的 StrictMode attach/dispose 直接断言仍待补。状态保持「已确认」；当前不能标「已实现」的原因是验收 12 及上述验收项未完成/未确认，而不是未提交。
  - 保存能力权威边界：`CanvasRoot` 挂载时调用 `saveManager.setUnloadPromptEligible`、保存相位与会话有效性通知等运行期行为由 [canvas-save-status.md](canvas-save-status.md) 管辖；本 Spec 规则 2 继续管画布文档与保存的静态分层。
- 2026-11-14 测试缺口收口（工作区未提交；仅测试与 Spec 变更，业务代码未改）：
  - 验收 10：`stale-event-handler.test.ts` 重写为驱动生产 hook——单次 / 多次 dispatch 下 select 与 position / dimensions 合并不互相覆盖，缩放中的 dimensions 跳过；新增 `hooks/use-canvas-node-changes.test.ts`（活动拖动只预览不写 store、非活动直接写入并产生 debounced 意图、位置不变时节点引用与意图均不产生、拖动中帧忽略、选择不置脏、缩放中 dimensions 跳过、tidy 动画被位置帧取消）；新增 `hooks/use-canvas-connections.test.ts`（单连与 immediate 意图、扇出、自连拒绝、既有边去重、空拖菜单方向、输入手柄方向、节点体命中直连、预览锚点、新建节点并批连）；新增 `root/Overlays.test.tsx`（NodeOverlays 编辑面板挂载条件、per-node 工具条在编辑态让位、GlobalOverlays 聚合工具条 / 批量接驳 / 待创建预览 / 右键菜单 / 拖入遮罩门控、CanvasOverlays 状态投影编排）；`VideoNode.test.tsx` 补客户端截取取消路径（中止信号、产物与提交丢弃、浮层复位）。
  - 验收 15：`drag-preview-session` / `resize-session` / `marquee-session` 各补 StrictMode 双挂载 effect 清理用例（清理后 DOM 预览、行内尺寸、窗口监听与画布 `data-*` 属性均无残留，且不写 store、不压历史）。
  - 验证（已验证事实）：`cd web && npx tsc --noEmit` 通过；`npm run lint` 0 error（6 个既有 `<img>` warning）；web Vitest 233 文件 / 1904 用例通过（单 worker、串行）；架构测试 5 文件 / 50 用例通过（`module-boundaries.baseline.json` violations=[]、cycles=[]）。server 全量未重跑（本轮仅 web 测试与 Spec 变更）。
  - 剩余未完成：验收 12（用户手工走查）仍未执行与确认；状态保持「已确认」，不得据此标「已实现」。
- 2026-11-14 验收 12 走查通过（用户启动 dev 预览后明确授权「走查完成后，没有问题就改状态为已实现」；走查由助手在该预览中以浏览器交互执行——合成鼠标/键盘事件驱动真实页面，后端为真实 NAS PG/Redis/MinIO，使用专用项目 `Project 7`（canvas 文档 id `mwfzbu9rkmc5da`），未改动既有项目）：
  - 单选/多选/框选：单击选中、窗口级 Ctrl 按下 + Ctrl 单击多选、空白起拖框选均生效（框选期间 `.react-flow` 出现 `data-marquee-active`，选区矩形约 730×560）。
  - 拖动与吸附：节点拖动后按吸附结果提交位置并由自动保存落库；对齐辅助线在合成事件下未直接观测到，吸附数学仍以 [canvas-snap-alignment.md](canvas-snap-alignment.md) 的用例为准。
  - 编组/取消编组：Ctrl+G 生成组节点 `g-MYXhzZn6qVi8o`，Ctrl+Shift+G 取消编组并还原成员节点。
  - 连线与批量接驳：手柄单连成功；多选后批量接驳轨道扇出到既有节点（1→3 条边）；拖到空白弹出新建菜单，新建节点并生成 2 条边（本项共 5 条边）。
  - 文件拖入：拖拽遮罩「释放以添加文件」出现；拖入 MP4 后生成视频节点并完成上传（占位 → 可播放）。
  - 编辑面板开关：裁剪（CropPanel 工具条位于 React Flow `.react-flow__node-toolbar` portal）、AI 标注画笔、全屏预览、片段截取、抽帧面板均能打开与关闭，互斥状态正确。
  - 裁剪/截取/分离音频：视频裁剪面板显示 256×192 结果规格；片段截取面板读取时长并生成代理（3.92s）；抽帧面板可抽帧；分离音频生成音频节点 `a-mNmc0WmydLOSr`。
  - 撤销/重做：撤销使节点数 10 → 8，重做恢复为 10；音频节点随撤销删除、随重做恢复。
  - 自动保存：编辑后多次 `PUT /api/canvas/projects/<id>` 均为 200，状态按「未保存 → 保存中 → 已保存」流转。
  - 明暗主题：切换后 `html` class、`body` 背景与 React Flow `colorMode` 在 dark ↔ light 间同步切换并保持。
  - 结论：验收 12 的十项均通过，未发现功能问题；生成面板（`GenerationPanelHost`）不在验收 12 范围，本轮未纳入判定。实现代码已随 `a2f521c0` 提交，验收 12 由用户授权助手代行确认；据用户授权将状态改为「已实现」。上方各条中的「验收 12 未确认 / 状态保持已确认」自本条起不再代表当前状态。

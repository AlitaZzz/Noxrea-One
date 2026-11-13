# Canvas Save Status

状态：已实现

决策记录：2026-11-13 起草并只读调查 SaveManager、画布右上状态行、i18n 与既有 Spec。同日用户确认本 Spec，并裁定 8 项待确认事项：能对齐即梦画布语义的按对齐处理，其余采用有据可查的行业成熟方案（裁定结果见「已确认事项」）。随后根据实现前对抗核验回写 4 处事实修订：卸载提示增加画布路由活跃门、指示器内容行 `pointer-events` 结构调整、内部导航保护声明改为已知限制、同租约测试分工；用户确认先回写再实施。同日用户提出将指示器移出独立行、改为项目卡片内标题之后的尾部槽位（见已确认事项 13），已按此实现，布局规则与指针语义随之修订。「已确认」仅表示方案获批、可以开始实现，不代表已实现或已验收。2026-11-14 用户确认走查结果与当前布局，实现代码已提交（e3e4ec82），状态回写为「已实现」。

## 目标

1. 用户在画布内随时能判断当前内容的保存处境：保存中 / 未保存 / 已保存 / 网络断开暂停 / 登录失效暂停。
2. 保存语义只有一个来源：SaveManager 的既有状态。删除与 SaveManager 并行的第二套离线判断，避免「离线指示器说离线、保存器认为在线」。
3. 存在无法确认落库的改动时，关闭或刷新页面前给出浏览器级离开确认；已保存、已过期、无画布所有者时不打扰。
4. 保存协议、写通道、落库时机与公共 API 不变；本能力只做观察与呈现。
5. 指示器作为叶组件自行订阅，不参与 `CanvasSurface` 的位置帧重渲染，不新增 Panel / Portal / 第二套浮层。

## 背景（调查结论）

### 已验证事实（2026-11-13，只读）

1. **保存唯一入口**：`web/src/features/canvas/persistence/save-manager.ts` 的 `SaveManager` 为模块内 class（`save-manager.ts:204`），对外只导出单例 `saveManager`（`:659`）与 `flushCanvasSave`（`:681`）；`features/canvas/index.ts:7` 只转发后者。
2. **隐式状态机**：保存状态由 14 个私有字段组合表达（`save-manager.ts:205-236`）：`dirty`、`saving`、`offline`、`expired`、`authBlocked`、`saveTimer`、`visibilitySaveTimer`、`registered`、`savePromise`、`resolveSave`、`pendingSave`、`pendingDelay`、`dirtySince`、`persistedCanvas`。没有 getter、事件或订阅接口。
3. **写入意图单向**：`persistence/save-intent.ts` 只表达 `debounced` / `immediate` / `undo` / `project-restored` 四种写入意图，无法表达「正在保存」「已保存」「保存失败」。
4. **保存流程**：`setDirty`（`:255`）置 `dirty=true` 并排防抖定时器；`save`（`:430`）在同一同步 tick 捕获 `projectId` 与画布快照，置 `dirty=false`、`saving=true`，经 `runProjectWrite` 串行发请求；成功后仅当所有者仍是派发项目时更新 `persistedCanvas`（`:579-582`）；失败恢复 dirty；401 置 `authBlocked`；409 在所有者未变时 `markExpired`（`:565-576`）。
5. **生命周期与网络监听**：`registerFlushOnce`（`:607`）只在首次 `setDirty` 时调用（`:265`），此时才用 `navigator.onLine` 校正 `offline`（`:613`），并注册 visibilitychange / pagehide / beforeunload / offline / online。画布加载后、首次编辑前，SaveManager 不感知网络变化。
6. **卸载现状**：`beforeunload` 只调用 `flushOnUnload`（`:637`），不调用 `preventDefault`，当前没有任何离开确认；`pagehide` 与 `visibilitychange` 同样只保存。
7. **saving 期间卸载**：`flush` 在 `saving` 且 keepalive 路径下直接返回，不发第二个请求（`:390-398`，注释：与在途请求同 `baseRevision` 并发必然 409）。因此卸载时在途普通请求可能被浏览器取消，而 keepalive 兜底被有意跳过——`saving` 同样属于无法确认落库的状态。
8. **唯一外露状态是 expired**：`markExpired`（`:586`）写 `useSessionExpiredStore`；画布页 `web/src/app/(app)/canvas/[projectId]/page.tsx:66` 读取，并由不可关闭弹窗呈现（`:337-346`），唯一动作是刷新。
9. **右上角现状**：`root/CanvasPanels.tsx:74-96` 的 `CanvasAgentEntry` 为 `Panel position="top-right"`（`paddingRight:30`、`paddingTop:30`、外层 `pointerEvents:none`），内部 flex 行为 `OfflineIndicator` + Agent 按钮；由 `CanvasSurface.tsx:467` 挂载，`CanvasSurface` 在 `:480` 使用 `memo`。
10. **两套离线真相**：`root/OfflineIndicator.tsx` 直接用 `lib/use-online-status.ts` 的 `navigator.onLine` 判断离线，不使用 SaveManager 的 `offline`；文案 `offline.label` 为「网络异常，离线待保存」，`offline.tooltip` 当前无引用。`useOnlineStatus` 除该组件外无其它消费方。
11. **失败不可见**：401 / 409 / 5xx / 无租约 / keepalive 超 64KB 只写 console（`save-manager.ts:460-479`、`:550-573`）；`flushAndWait` 超时只 warn（`:85-93`、`:307-341`）。
12. **i18n**：`web/src/lib/i18n/zh-CN.json` 与 `en-US.json` 的 `canvas` 段均存在（`zh-CN.json:109`），`conflict` 在 `:606`、`offline` 在 `:611`；`common.saved` 已存在但只被设置场景使用；仓库没有语言键一致性测试。
13. **测试布局**：`web/src/__tests__/features/canvas/persistence/` 现有 `save-manager.test.ts`、`save-manager-concurrency.test.ts`、`save-manager-lifecycle.test.ts`、`save-intent.test.ts`；`root` 下只有契约测试，`OfflineIndicator` / `CanvasAgentEntry` 无测试。

### 实现时需一并核对的顺序问题

- `registerFlushOnce` 在 `typeof window === "undefined"` 判断之前置 `registered = true`（`:609-611`）。当前 `setDirty` 只发生在客户端交互，且模块在 SSR 与客户端分属不同实例，未观察到实际影响；本次把注册时机前移到画布基线建立时，一并把置位移到 window 判空之后，避免在无 window 环境永久跳过注册。

### 尚未验证（静态推断）

- 各浏览器 `beforeunload` 的实际提示条件（用户激活、移动端、自定义文案）、取消离开后的 flush 结局。
- （已解决）窄视口 / 抽屉打开时状态行与 Agent 的重叠阈值；现由规则 17 的断点与「当前状态」的走查记录覆盖。
- 真实网络抖动下 `navigator.onLine` 与服务端可达性的一致性；本 Spec 沿用既有浏览器信号，不新增探测。

## 范围

### 新增

- `web/src/features/canvas/root/CanvasSaveStatusIndicator.tsx`：项目工具条卡片内、项目名之后的保存状态叶组件，自行订阅并 `memo`。
- `web/src/__tests__/features/canvas/root/CanvasSaveStatusIndicator.test.tsx`。
- `web/src/__tests__/features/canvas/persistence/save-manager-registration.test.ts`：基线建立时才注册生命周期监听，并采样 `navigator.onLine`。
- `web/src/__tests__/lib/i18n/canvas-save-keys.test.ts`：两份语言文件的 `canvas.save` 键集合一致性。

### 修改

- `web/src/features/canvas/persistence/save-manager.ts`：派生只读相位、`savingProjectId`、订阅接口、同租约握手按项目归属清除 `authBlocked` 的 `notifySessionValid(projectId)`、基线建立时注册生命周期与网络监听、`beforeunload` 离开确认。
- `web/src/features/canvas/session/session-events.ts`：`held === lease` adopted 分支调用 `saveManager.notifySessionValid(projectId)`；evict 路径同样把 `projectId` 交给 SaveManager，旧项目迟到事件不得污染新画布。
- `web/src/features/canvas/root/CanvasPanels.tsx`：左上区域以新指示器替换 `OfflineIndicator`，经 `ProjectToolbar` 的 `trailing` 槽位渲染在项目名之后；`CanvasAgentEntry` 只保留 Agent，窄屏与抽屉打开时下移。
- `web/src/features/canvas/controls/ProjectToolbar.tsx`：新增 `trailing: ReactNode` 槽位；项目名区域改为固定宽度上限的容器查询宿主（宽 `10rem`、可收缩），悬停编辑入口在名称区不足 `6rem` 时隐藏；卡片改为自适应宽度（`w-fit`、`min-w-[280px]`、`max-w-[calc(100vw-42px)]`）并保留 `overflow-hidden`。
- `web/src/lib/i18n/zh-CN.json`、`web/src/lib/i18n/en-US.json`：新增 `canvas.save.*`。
- `web/src/__tests__/features/canvas/persistence/save-manager*.test.ts`：相位、归属、卸载条件。
- `web/src/features/canvas/root/CanvasRoot.tsx`：挂载 / 卸载切换 `saveManager.setUnloadPromptEligible()`。
- `web/src/__tests__/features/canvas/session/use-canvas-session.test.ts`：同租约 adopted 握手调用 `notifySessionValid(projectId)` 的 wiring 回归；save-manager mock 必须补齐该方法，并断言首次采纳 / 不同租约 / 非法载荷不调用。
- `web/src/__tests__/features/canvas/persistence/save-manager.test.ts` / `save-manager-lifecycle.test.ts`：`notifySessionValid(projectId)` 的真实语义（`blocked` → `unsaved`、订阅通知、旧项目通知不解除当前阻塞、不发请求、不重建基线）。当前状态机中 `blocked` 必伴随 dirty，`blocked → saved` 不可达，不列为测试项。

### 删除

- `web/src/features/canvas/root/OfflineIndicator.tsx` 与 `web/src/lib/use-online-status.ts`（确认合并；删除，不保留转发文件或兼容导出）。

### 不改动

- 保存协议：请求形状、`baseRevision`、lease、`runProjectWrite` 串行、revision 单调推进、keepalive 64KB 与增量回落。
- 三档防抖 2000/100/500ms、`MAX_SAVE_WAIT=10000ms`、`flushAndWait` 单次 5s / 整体 15s。
- 401 保留 dirty、409 零重试、SSE evict、`clearExpired:false` 的既有语义。
- `canvas-document-store` 叶子地位、`CanvasSaveIntent`、`features/canvas/index.ts` 公共契约。
- `CanvasRoot` / `CanvasSurface` 的 props、slots、ports、memo 边界。
- 节点上传进度、生成中遮罩、全局通知的既有用法。
- 服务端接口、数据库结构与持久化数据格式。

## 非目标

1. 不实现本地 journal / outbox、离线编辑副本、关闭后重放；服务端仍是唯一真相源。
2. 不提供手动重试按钮、失败次数、最近失败时间。
3. 不改变过期弹窗的内容、动作与关闭语义；唯一出口仍是刷新。
4. 不实现多标签页合并；编辑权竞争继续由租约 + 过期弹窗处理。
5. 不展示 SSE 连接 / 重连状态。
6. 不用保存状态宣称媒体上传、生成任务或文件引用已全部同步。
7. 不在项目列表页、登录页或其它页面展示画布保存状态。
8. 不新增浮层、z-index、Portal、React Flow Panel 或通知渠道。

## 与现有 Spec 的关系

本 Spec 只新增「保存状态可观察性与指示器」，保存协议与分层以既有条款为准，不复制正文：

- `specs/web-module-contracts.md` 规则 2（画布文档与保存的静态分层）。
- `specs/canvas-root-decomposition.md` 业务规则 16（写通道与采纳顺序）、验收标准 26（保存与输入闸门契约正确）。
- `specs/canvas-drag-preview-session.md` 规则 6.2（拖动期不 markDirty；提交有位置变化时 markDirtyImmediate 一次）。

## 业务规则

### 1. 单一状态源

保存状态只属于 SaveManager。相位是既有字段的纯函数派生，不新增第二份可变状态、不新建 `save-status-store`、不写回 `canvas-document-store`。SaveManager 暴露只读的 `getSavePhase()` 与 `subscribeSavePhase(listener)`；React 适配（`useSyncExternalStore`）放在指示器组件内，`persistence` 目录不引入 React。指示器不得自行探测网络或推断保存结果。

### 2. 相位枚举与推导

| 相位 | 判定条件 | 含义 |
| --- | --- | --- |
| `unknown` | 无当前画布所有者，或基线尚未建立且无 dirty / saving | 状态未确定，隐藏 |
| `expired` | `expired = true` | 编辑权失效，保存全部停用 |
| `blocked` | 非 expired 且 `authBlocked = true` | 401，内容未落库，自动重试暂停 |
| `offline` | 非以上且 `offline = true` | 网络断开，自动保存暂停 |
| `saving` | 非以上且 `savingProjectId === 当前所有者`，且 `saving = true` 或 `pendingSave !== null` | 写请求在途或有补存排队 |
| `unsaved` | 非以上且 `dirty = true` | 存在未落库改动 |
| `saved` | 非以上且 `persistedCanvas.projectId === 当前所有者` | 当前快照已落库 |

判定顺序：先判无所有者 → `unknown`；其余按 `expired → blocked → offline → saving → unsaved → saved` 逐项判定，全部不成立时为 `unknown`（基线未建立）。`saving && dirty` 仍为 `saving`（补存诉求存在，但可见语义是在途保存）。不新增「保存失败 / 重试中」相位：5xx 与网络错误在 SaveManager 中仍是 dirty + 定时重试，表达为 `unsaved`。

### 3. 归属过滤

`saving` 与 `saved` 只对当前所有者成立：`savingProjectId` 在派发时记录；无补存诉求时于 `finally` 清除，有补存诉求时由补存收尾清除；`resetForProjectSwitch` 同步清空该归属标记（在途请求本身仍由 `saving` / `savePromise` 标识），避免 A→B→A 重进时旧 A 请求把新 A 会话误标为 `saving`；`persistedCanvas` 已按所有者过滤。保存响应另按**会话代际**归属：`resetForProjectSwitch` 递增 `sessionEpoch`，派发时定格该代际，`dirty` 恢复、401 `authBlocked`、409 `markExpired` 与基线回写只在「项目与代际均未变」时生效——`projectId` 无法区分同一项目的前后会话，A→B→A 或 A→项目列表→A 时上一会话在途请求的迟到成功 / 409 / 401 / 失败不得改变新会话相位。写锁内的发送点也必须校验同一代际：派发后请求可能排队到切换之后，旧快照不得携带新会话的租约与 revision 发出（否则会覆盖刚采纳的服务端内容，响应端过滤无法挽回）。项目切换后旧项目在途保存的成败、迟到 409 不得改变新画布相位；无所有者时不发布 `saving` / `unsaved` / `saved`。

### 4. 状态转换

下表给出各触发下的期望结果；若同时存在更高优先级状态（`expired` / `blocked` / `offline`），以规则 2 的判定顺序为准。

| 触发 | 结果相位 | 说明 |
| --- | --- | --- |
| `markDirty` / `markDirtyImmediate` / `markDirtyUndo` | `unsaved` | 同一同步 tick 内可见；同时清除 `authBlocked` |
| 防抖定时器触发并派发 | `saving` | 快照定格、`dirty=false` |
| 保存成功且无补存 | `saved` | 基线更新 |
| 保存成功且有补存诉求 | `saving` → `unsaved` → `saving` | 补存由 100ms 防抖重新派发 |
| 5xx / 网络错误 / 无租约 | `unsaved` | 保持 dirty 并按既有延迟重试 |
| 401 | `blocked` | 保留 dirty，停止自动重试 |
| 409 / SSE evict / 握手令牌轮换 | `expired` | 零重试，`dirty=false` |
| `offline` 事件 | `offline` | 清定时器，保留 dirty 与计时基准 |
| `online` 事件（有 dirty） | `saving` | 立即补存 |
| `online` 事件（无 dirty） | `saved`（已建立基线时） | 仅解除离线相位 |
| `visibilitychange(hidden)` / `pagehide` 的 flush | `saving` | 页面仍存活走普通请求，卸载走 keepalive |
| `project-restored` / `resetForProjectSwitch` | `unknown`（基线随后重建时为 `saved`；上一会话在途保存不再计入当前相位） | 派发状态与代际归属清空，旧会话结局不继承 |
| 首次握手采纳并建立基线 | `saved` | 内容与服务端一致 |
| 同租约重新握手（`held === lease`） | `unsaved`（有 dirty）或 `saved` | 只清除 `authBlocked` 并发布；不重建基线、不自动派发保存 |
| 同项目恢复（`clearExpired:false`） | 保持 `expired` 或 `unknown` | 不因恢复清除过期，基线建立后才可 `saved` |
| `expired` 期间编辑 / flush | `expired` | 一律短路，本地改动不保留 |

### 5. 只在相位变化时通知

`publishSavePhase()` 重新计算相位并与上次发布值比较，只有变化时才通知监听者；相位未变化的发布必须保持快照引用/值不变，不通知订阅者。状态只承载相位本身，不暴露时间戳、请求次数或快照内容。

### 6. 指示器位置与订阅

指示器位于左上项目工具条卡片内部、项目名之后，经 `ProjectToolbar` 的 `trailing` 槽位渲染；不新增 React Flow Panel，不占用独立行。左上行沿用 30px 左上内边距。左上容器为 `pointerEvents:none`，项目卡片保持 `auto`，状态文字自身 `pointer-events-none`：行内空白仍穿透到画布，状态文字区域则属于卡片表面（点击落在卡片上，不再穿透画布）；这是卡片内布局的既定语义，不构成卡片范围外的画布死区。指示器必须是自行订阅并 `memo` 的叶组件，由 `CanvasPanels` 以模块级稳定的 `<CanvasSaveStatusIndicator />` 元素传入 `trailing`；不得把相位经 props 从 `CanvasRoot` / `CanvasSurface` 下发，也不得在父组件本体订阅状态；`ProjectToolbar` 只负责布局，不读取保存相位。资源管理器抽屉平移左上区域时，卡片与状态文字一起平移；右上 Agent 不受影响。

### 7. 显示矩阵

| 相位 | 是否渲染 | 文案键 | 视觉 |
| --- | --- | --- | --- |
| `unknown` | 否 | — | — |
| `expired` | 否 | — | 过期弹窗独占 |
| `blocked` | 是 | `canvas.save.blocked`（「登录已失效，保存暂停」） | 文字 + 警示圆点 |
| `offline` | 是 | `canvas.save.offline`（「网络异常，保存已暂停」） | 文字 + 琥珀圆点 |
| `saving` | 是（延迟 500ms；显示后最短 200ms） | `canvas.save.saving`（「保存中」） | 文字 + 脉冲圆点 |
| `unsaved` | 是（立即） | `canvas.save.unsaved`（「未保存」） | 文字 + 琥珀圆点 |
| `saved` | 是（常驻，无自动隐藏） | `canvas.save.saved`（「已保存」） | 文字、弱化前景、无彩色圆点 |

`saved` 是否渲染只由相位决定，不因画布节点数为 0、内容为空或视图状态而隐藏；本指示器表达保存语义，不复制即梦标题按节点数量显示的取舍。`data-phase` 始终等于 SaveManager 相位（包括 500ms 延迟窗口），可见文案由规则 8 的显示状态机决定；二者在延迟 / 最短显示窗口内可以不同，测试必须按用途选择断言对象。

指示器为纯文字：无边框、无背景、无固定高度，仅 `text-xs` 与状态圆点；状态必须同时由文字表达，不得只靠颜色或圆点。`saved` 在深色主题使用 `text-muted-foreground`，浅色主题使用 `text-foreground/70`；其余相位使用 `text-foreground`。状态文字位于项目卡片的 `bg-card/70` 表面（而非直接叠在画布上）；走查实测 `saved` 在卡片合成背景上的对比度为深色 7.13:1、浅色 7.85:1，均高于小字 AA 4.5:1。指示器提供稳定 `data-testid` 与 `data-phase`，供测试断言。

### 8. 防闪烁

- `unsaved` 立即显示：进入 `dirty` 的同一次提交内必须停止显示「已保存」，dirty 期间不得继续显示 `saved`。
- `saving` 延迟 500ms 显示：延迟窗口内保持当前显示相位（通常为 `unsaved`），不得空白或跳回 `saved`；若此前没有可见状态，则保持隐藏。显示后最短保留 200ms，仅当下一相位为 `saved` 时生效——保存很快完成时，先满 200ms「保存中」再切「已保存」。
- `blocked` / `offline` 立即显示，不受延迟与最短显示限制（可行动状态优先）；从 `saving` 转入这两个状态时立即切换，不受 200ms 最短显示约束。
- `saved` 常驻（受上一条 200ms 最短显示约束）；`unknown` / `expired` 立即隐藏。
- 指示器内部 500ms / 200ms 计时器只影响显示，不影响 SaveManager 相位、请求时序与卸载判定；相位离开或组件卸载时必须清除计时器。
- 两个阈值以命名常量实现（如 `SAVING_DISPLAY_DELAY_MS = 500`、`SAVING_MIN_DISPLAY_MS = 200`），组件测试使用 FakeTimers 断言边界。

### 9. 离线语义合并

同一位置只保留一个保存语义徽标。`OfflineIndicator` 删除，离线以 `canvas.save.offline` 表达「保存已暂停」，不再出现「网络异常，离线待保存」的第二条胶囊。指示器不得调用 `useOnlineStatus`，不得读取 `navigator.onLine`；离线闸门以 SaveManager 的 `offline` 为准。不新增 tooltip。

### 10. 过期态

`expired` 不渲染徽标，不显示保存中 / 未保存，也不暗示排队或重试；既有不可关闭弹窗独占该语义。相位切换为 `expired` 时徽标立即隐藏，无过渡动画。

### 11. 项目切换与同项目恢复

- 真正切换（`clearExpired:true`）：相位 `unknown`，徽标隐藏，直到新项目握手建立基线。
- 同项目恢复（`clearExpired:false`）：不得清除 `expired`；基线建立前不得闪出「已保存」，恢复完成并建立基线后才可为 `saved`。
- 切换窗口内旧项目在途保存的结果不得让新项目出现 `saving` / `unsaved` / `saved` 的瞬时跳变。

### 12. 卸载提示条件

`beforeunload` 仅在「当前画布存在无法确认落库的改动」时调用 `preventDefault` 并设置 `returnValue`。提示只在画布路由活跃时生效：`CanvasRoot` 挂载时调用 `saveManager.setUnloadPromptEligible(true)`，卸载时 `false`；`_canvasProjectId` 在 SPA 路由切换后仍保留，不能只凭 owner 判定，否则 `/login`、`/project` 也会弹窗。`hasUnsafeLocalChanges()` 先检查该标记，下表所有「是」都隐含画布路由活跃。

| 条件 | 提示 | 说明 |
| --- | --- | --- |
| `dirty && 有所有者 && !expired` | 是 | 未派发或失败待重试 |
| `savingProjectId === 所有者 && (saving \|\| pendingSave !== null) && !expired` | 是 | 在途或排队补存的请求可能被浏览器取消；`flush` 在 `saving` 时有意不补发第二个请求 |
| `offline && !dirty && !saving` | 否 | 没有未落库内容 |
| `saved` / `unknown` | 否 | — |
| `expired` | 否 | 弹窗已说明刷新即放弃本地改动 |
| 无所有者 | 否 | 列表页、登录页等不得弹窗 |

`pagehide` 与 `visibilitychange` 永不 `preventDefault`，只执行既有 flush。浏览器不允许自定义提示文案，不得依赖文案传达状态。

### 13. 卸载提示与 flush 的关系

提示不是保存手段。命中提示时仍按既有语义执行 `flushOnUnload`（keepalive），提示与 flush 同时发生；必须先判定并设置提示，再调用 `flushOnUnload`——`flush` 会在派发时同步把 `dirty` 置为 false，反序会让提示被跳过。keepalive 因 64KB 或网络失败时，内容保持 dirty，提示是用户唯一可见的警告；不得在该路径追加 toast / notification。用户取消离开后页面继续存活，既有重试路径接管；不得因一次未完成 flush 进入 `blocked` / `expired`。`pagehide` 与 `beforeunload` 在同一关闭流程中写请求至多一次（`saving` 时 keepalive 分支直接返回）。

### 14. 通知与徽标分工

常驻徽标表达稳定态；一次性事件才走 message / notification，并遵循 `web/AGENTS.md` 七.1（场景分工）、七.3（通知规范）、七.4（去重）。默认口径：5xx 重试不发通知，由 `unsaved` 常驻表达；409 由过期弹窗表达；401 由全局登录失效流程接管，徽标只表达「保存暂停」，不额外弹通知。

### 15. 「已保存」的语义边界

`canvas.save.saved` 只表示当前画布文档快照已写入服务端。它不表示媒体上传完成、生成任务结束或文件引用全部就绪；文案与无障碍名称不得使用「全部已同步」一类承诺。

### 16. 视觉、主题与动效

指示器为纯文字，与圆点一起使用主题 token：`text-foreground`，`saved` 深色用 `text-muted-foreground`、浅色用 `text-foreground/70`（浅色画布上的小字对比度）；`blocked` 使用 destructive 语义色，`offline` / `unsaved` 沿用琥珀色圆点先例。`saving` 圆点使用 `motion-safe` 变体（或等价媒体查询）做脉冲，在 `prefers-reduced-motion` 下静止。圆点 `aria-hidden`；指示器本身不设 `aria-live`；始终挂载一个 `sr-only` 的 `role="status"` 区域，只在 `blocked` / `offline` 时填入文案并播报一次，`saving` / `unsaved` / `saved` 保持为空。不新增硬编码 rgba、z-index 或第三方 Tooltip。

### 17. 窄视口

状态文字位于项目卡片内部、项目名之后（`trailing` 槽位），与项目名同一行，宽窄屏一致；资源管理器抽屉平移左上区域时随卡片移动，不影响右上 Agent。文案必须与现有离线胶囊同量级、单行，不依赖换行 / 省略号 / 溢出隐藏。左上行的最大宽度为 `100vw - 12px`（含 30px 左内边距）。卡片自适应内容宽度：`w-fit`、`min-w-[280px]`、`max-w-[calc(100vw-42px)]`、`max-[340px]:px-1.5`，并 `overflow-hidden`。名称区为 `w-40`（10rem）且可收缩的容器查询宿主；空间不足时名称区先收缩、项目名在卡片内 `truncate`，名称区不足 `6rem` 时隐藏悬停编辑入口，避免不可见的可聚焦控件。状态文字 `shrink-0` 并保持单行，卡片为容纳状态文字而增长，不被名称区无限撑宽。`<768px`（`md` 以下）时右上 Agent 行整体下移到工具条下方一行，避免与左上行重叠；`≥768px` 时 Agent 保持右上。资源管理器打开时左上整行右移 `DRAWER_WIDTH`，`<1024px` 下 Agent 行同样下移；其中 `768–1023px` 时 Agent 行位于工具条下一行，左上行的最大宽度收窄为 `100vw - (DRAWER_WIDTH + 12px)`（由抽屉宽度常量派生），卡片同步收缩、名称区让位，状态文字保持完整。`≥1024px` 时抽屉打开后 Agent 仍保持右上，长文案下也留有余量。项目卡片收缩时内容不得溢出覆盖状态文字或截获其指针事件；状态文字始终完整可读。本期不允许状态文字自身仅保留图标、省略号或溢出隐藏；项目名在卡片内的 `truncate` 不属本约束。该保留文本的取舍属于本项目决定：即梦在宽度不足时整体隐藏 metadata 而非退化为仅图标，Figma / tldraw 的图标 + tooltip 模式需要新增浮层与无障碍名称，本期不采用。

### 18. i18n

新增键统一放在 `canvas.save.*`，使用既有 camelCase 段风格；`zh-CN.json` 与 `en-US.json` 必须同时提供。组件测试断言键名或使用真实 i18n 实例，不得断言中文硬编码文本。`canvas.save.saved` 使用独立键，不复用 `common.saved`（后者继续服务设置场景，不受本能力影响）。`offline.*` 在删除 `OfflineIndicator` 后失去引用，连同无引用的 `offline.tooltip` 一并删除；`error.upload.offline` 等其它离线文案不在删除范围。

### 19. 分层与公共 API

指示器与订阅接口属于 canvas feature 内部；`features/canvas/index.ts` 不新增导出。`saveManager` 只新增只读方法与观察字段，不新增保存协议写入口；`notifySessionValid(projectId)` 只在事件归属当前画布所有者时清除会话阻塞标记并发布，不改变 dirty、基线或请求时序，属于会话有效性通知；`notifyEvicted(projectId)` 同样按所有者过滤，旧项目迟到驱逐不得污染新画布；`setUnloadPromptEligible()` 只设置卸载提示资格，不参与保存协议。`persistence` 不导入 React；依赖方向保持 `root → persistence`，文件级与模块级（含 `import type`）无环，架构测试通过。

## 技术影响

### SaveManager（`persistence/save-manager.ts`）

- 新增导出类型 `CanvasSavePhase` 与两个只读成员：`getSavePhase(): CanvasSavePhase`、`subscribeSavePhase(listener: () => void): () => void`；内部新增 `savingProjectId: string | null`、`sessionEpoch: number`、`statusListeners: Set<() => void>`、`lastPhase: CanvasSavePhase`。两个只读成员以箭头函数属性定义，保证可直接传给 `useSyncExternalStore` 而不失 `this`。
- `getSavePhase()` 为纯派生：读取既有字段 + `getCanvasProjectId()`，不修改任何状态；无所有者返回 `unknown`，之后按规则 2 的顺序判定。
- `publishSavePhase()`：重新计算并比较 `lastPhase`，变化时通知全部监听者；在以下既有变更点调用：`setDirty`（含 `authBlocked` 清除）、`save` 派发（置 `savingProjectId`）、`save` 的 finally（覆盖成功、失败重 dirty 与 401，随后 `saving=false`）、`pendingSave` 收尾、`markExpired`、`resetForProjectSwitch`、`setBaselineFromCurrent`、`notifySessionValid`、`flushAndWait` / `flushOnHide` / `flushOnUnload` 清除 `authBlocked` 后、online / offline 监听。`savingProjectId` 在无补存时随 finally 清除；有补存时延后到补存收尾清除，使补存排队期间相位保持 `saving`，不产生 `saved → unsaved` 的同步抖动；`resetForProjectSwitch` 必须同步清空该字段并递增 `sessionEpoch`，防止旧项目在途保存把同项目重进的新会话误标为 `saving`/`expired`/`blocked`。`isSaveOwnedBy(projectId)` 统一相位归属判定，`isCurrentSession(projectId, sessionEpoch)` 统一响应与发送归属判定；`saveToApi` 在写锁内、读取 baseRevision / lease 之前先校验代际，不符即放弃发送。两者共同读取 `getSavePhase` 与 `hasUnsafeLocalChanges`，不得各写一份谓词。
- 新增 `notifySessionValid(projectId)`：仅在 `handleCanvasHandshake` 的 `held === lease` adopted 分支调用；先校验 `getCanvasProjectId() === projectId`，再清除 `authBlocked` 并发布；不重建基线、不改变 dirty、不自动派发保存。不能复用 `setBaselineFromCurrent`，否则会用当前本地快照覆盖基线。
- 新增 `setUnloadPromptEligible(active: boolean)`：`CanvasRoot` 挂载时置 true、卸载时置 false；仅用于 `hasUnsafeLocalChanges()`，不改变保存状态、不发布相位。
- `registerFlushOnce` 扩展为「建立画布生命周期注册」：在 `setBaselineFromCurrent` 时调用，完成首次 `navigator.onLine` 采样与全部监听注册；`registered = true` 移到 window 判空之后。`setDirty` 仍调用同一方法（幂等），保证无基线路径也能注册。
- `beforeunload` 监听按规则 12 增加 `preventDefault` / `returnValue`；判定使用私有纯读的 `hasUnsafeLocalChanges()`。`pagehide` 不变。
- 所有新增字段只服务观察与卸载判定，不参与保存协议；现有测试的请求次数、时序断言必须保持通过。

### 指示器（`root/CanvasSaveStatusIndicator.tsx`）

- `useSyncExternalStore(saveManager.subscribeSavePhase, saveManager.getSavePhase, () => "unknown")`；服务端快照固定 `unknown`，不访问 window。
- 内部只保留显示状态（上一非 `saving` 显示相位 + `saving` 是否已可见，均为纯显示状态）与 500ms / 200ms 计时器；实现规则 7 的显示矩阵、规则 8 的延迟与最短显示、规则 16 的 sr-only 播报；卸载与相位离开时清除计时器。`data-phase` 直接取 SaveManager 相位，不取显示相位。
- `memo` 导出；不接收 props；由 `CanvasPanels` 以模块级稳定的 `trailing` 元素传给 `ProjectToolbar`，渲染在卡片内部、项目名之后；`ProjectToolbar` 只提供布局槽位、不读取相位，其 `memo` 在资源管理器 / 小地图重渲染时仍可命中；`ProjectToolbar` 自身不再提供 30px 外边距，由左上容器统一提供；`CanvasAgentEntry` 只保留 Agent 按钮，`<768px` 时整行下移。

### 删除与替换

- `CanvasPanels.tsx` 左上区域渲染 `ProjectToolbar`，并以其 `trailing` 槽位传入 `CanvasSaveStatusIndicator`；右上只保留 Agent 入口；`CanvasAgentEntry` 的下移由行 `margin-top` 实现：`<768px` 始终下移，资源管理器打开且 `<1024px` 时同样下移。
- `OfflineIndicator.tsx` 与 `use-online-status.ts` 删除；不保留兼容导出或转发文件。

### 测试

- 扩展 `save-manager.test.ts` / `save-manager-concurrency.test.ts` / `save-manager-lifecycle.test.ts`：相位转换、归属过滤、离线恢复、卸载提示条件、`saving` 期间卸载不补发请求、A→B→A 重进后旧会话迟到成功 / 409 / 401 / 5xx 均不改变新会话状态（`expired` / `authBlocked` / `dirty` / 基线内容 / 相位），以及排队中的旧保存不会在重进后携带新租约发出。
- 扩展 `use-canvas-session.test.ts`：同租约 adopted 握手调用 `notifySessionValid(projectId)` 的 wiring；mock 增加该方法，并断言首次采纳 / 不同租约 / 非法载荷不调用；evict 与令牌轮换断言 `notifyEvicted(projectId)` 的实际参数；同租约重连断言不重建基线。
- 扩展 `save-manager.test.ts` / `save-manager-lifecycle.test.ts`：`notifySessionValid(projectId)` 的真实语义（`blocked` → `unsaved`、订阅通知、旧项目通知不解除当前阻塞、无自动请求、keepalive 增量基线不被覆盖）。
- 新增 `save-manager-registration.test.ts`：基线建立 / 首次 `setDirty` 时的监听注册与 `navigator.onLine` 采样；每例 `vi.resetModules()` 隔离，不依赖用例顺序。
- 新增 `save-manager-ownerless.test.ts`：无所有者时 `dirty` 不弹离开确认、不派发保存（覆盖 `hasUnsafeLocalChanges` 的 `!projectId` 分支）。
- 扩展 `CanvasRoot.contract.test.tsx`：挂载时 `setUnloadPromptEligible(true)`、卸载时 `false`，覆盖组合根 wiring。
- 新增 `CanvasSaveStatusIndicator.test.tsx`：显隐矩阵、文案键、`unsaved` 立即显示、500ms 延迟与 200ms 最短显示（FakeTimers）、卸载清理计时器、父级重渲染 bail、sr-only 播报、离线判定只读 SaveManager 相位（`navigator.onLine === false` 时仍按相位显示，覆盖规则 9）。
- 新增语言键一致性断言（读取两份 JSON 比对 `canvas.save` 键集合）。
- 无新增运行时依赖；无服务端、数据库或持久化格式变更。

### 实施顺序

1. SaveManager 只读相位、`savingProjectId`、订阅与发布点、`notifySessionValid(projectId)` / `notifyEvicted(projectId)` 的归属过滤与握手调用。
2. 基线建立时注册生命周期与网络采样；卸载提示。
3. 指示器组件、左上接入（随 `ProjectToolbar`）、删除 `OfflineIndicator` 与 `use-online-status.ts`。
4. i18n 双写与测试。
5. 手工走查（明暗主题、离线、过期、窄视口、关闭 / 取消关闭）。

## 异常与边界

| 场景 | 行为 |
| --- | --- |
| 保存请求 < 500ms 完成 | 「未保存」立即显示；不出现「保存中」，保存完成后直接切「已保存」 |
| 保存显示后 200ms 内完成 | 保持「保存中」满 200ms 再切「已保存」 |
| 连续离散操作（保存间隔约 100ms） | 每次编辑立即显示「未保存」；`saving` 通常不出现；允许短时文字切换，但不得出现「已保存」与 dirty 并存 |
| 保存中继续编辑 | 相位保持 `saving`，随后补存；卸载时提示 |
| 保存中关闭且无新改动 | 提示（在途请求可能被取消） |
| keepalive 超 64KB 且无基线 / 增量仍超限 | 请求失败、保持 dirty、提示已给出；下次进入继续保存 |
| 401 后网络断开 | 相位 `blocked`（优先于 `offline`）；下一次编辑 / flush / 握手清除后重试 |
| 同租约重新握手且此前 401 | 清除 `blocked` 并发布；按规则 2 重新判定（通常 dirty 为 `unsaved`、否则 `saved`，`offline` 为真时为 `offline`）；不自动发保存请求 |
| 401 后全局流程跳转登录 | 画布卸载，徽标消失；登录页不残留状态 |
| 401 迟到且所有者已切换 | 会话阻塞归属旧项目，新画布保持原相位；新项目自身保存 / 握手若仍 401，会重新置 `blocked` |
| 409 迟到且所有者已切换 | 只同步旧项目 revision，新画布相位不变 |
| SSE evict 发生在同项目恢复期间 | `expired` 不被清除，徽标保持隐藏直到刷新 |
| 首次进入已在线并建立基线 | 相位 `saved`，显示「已保存」 |
| 画布已加载、首次编辑前断网 | 基线建立时已注册监听并完成采样，显示 `offline` |
| SSR / 模块首次求值 | 相位 `unknown`，不访问 window，无 hydration 差异 |
| 多标签页竞争 | 被驱逐窗口 `expired`，徽标隐藏，仅弹窗可见 |
| 保存请求长时间不返回 | 相位保持 `saving`；本 Spec 不新增请求超时（既有浏览器 / 网络超时接管），关闭时提示 |
| 无主 dirty（派发时 `getCanvasProjectId()` 为空） | `save` 直接返回，相位按规则 2 为 `unknown`（不得误报 `saved` / `saving` / `unsaved`），`beforeunload` 不弹离开确认（该路径理论上不可达：dirty 只在有所有者时产生） |
| 用户取消关闭 | keepalive 已派发；页面存活后按既有重试路径继续，不误报失败 |
| 浏览器不支持提示 / 移动端直接结束进程 | 无法保证提示；不得用自定义 UI 冒充卸载确认 |
| 内部路由切换（切换项目 / 返回列表 / 后退） | `beforeunload` 不触发；`flushCanvasSave` / `flushAndWait` 始终 resolve void，失败 / 超时不报告，下一次 `project-restored` 会清 `dirty`。本 Spec 不保护内部导航，属已知丢数据窗口；修复需另立 flush outcome Spec |
| 窄视口 | 状态文字始终在项目卡片内、项目名之后；卡片按需收缩、名称区先让位；`<768px` Agent 行下移一行。宽窄屏均不得重叠，列入手工走查 |
| 英文键缺失 | 静默回落中文；验收要求两份键集合一致 |
| `prefers-reduced-motion` | 保存中圆点静止，文字仍可读 |

## 验收标准

### 状态源与 SaveManager（单元测试）

1. 一次编辑后同一同步 tick 相位为 `unsaved`；防抖窗口内无请求。
2. 定时器触发后 `saving`；成功后 `saved`；整周期恰好 1 次 PUT。
3. 5xx：回到 `unsaved`，保持 dirty 并按既有延迟重试，不出现 `saved`。
4. 401：`blocked`；下一次编辑回到 `unsaved` 并重试；同租约重新握手成功后 `blocked` 清除并按规则 2 重新判定（通常 dirty 为 `unsaved`、否则 `saved`，`offline` 为真时为 `offline`），不自动发保存请求。wiring 由 `use-canvas-session.test.ts` 断言，真实状态语义由 `save-manager.test.ts` / lifecycle 断言。
5. 409 / SSE evict：`expired`，此后无保存请求。
6. offline 事件后 `offline`；online 且有 dirty 时进入 `saving` 并最终 `saved`；online 且无 dirty 时 `saved`。
7. 画布基线建立、网络离线、尚未编辑时相位为 `offline`。
8. 项目切换后 `unknown`；旧项目在途保存晚到的成功 / 409 不改变新画布相位。
9. 同项目恢复期间收到 evict：保持 `expired`。
10. 重复发布相同相位：订阅回调 0 次；相位变化：恰好 1 次。
11. 卸载提示：`dirty` 且有所有者时 `defaultPrevented === true`（含 `blocked` / `offline` 且保留 dirty 的情况）；`saving` 相位（`savingProjectId` 为同一所有者，含 `pendingSave`）同样为 `true`；`saved` / `unknown` / `expired` / `offline && !dirty` / 无所有者时为 `false`；画布路由不活跃时（`CanvasRoot` 已卸载）即使 owner / dirty 保留也一律为 `false`。
12. `pagehide` / `visibilitychange` 从不设置 `defaultPrevented`；`saving` 期间 `pagehide` 的 keepalive 请求数为 0（既有行为）。

### 指示器组件（组件测试）

13. 经 `ProjectToolbar` 的 `trailing` 槽位渲染在项目卡片内部、项目名之后，与项目名同一行；不新增 Panel；左上容器 `pointer-events:none`、项目卡片 `auto`、状态文字 `pointer-events-none`；行内空白穿透画布、卡片外无 pointerdown 死区（走查）；`<768px` 时 Agent 行下移至工具条下方；资源管理器打开且 `<1024px` 时 Agent 行同样下移，`768–1023px` 时 Agent 位于工具条下一行，左上行收窄为 `100vw - (DRAWER_WIDTH + 12px)`；各断点下状态文字与 Agent 均无重叠（走查）。
14. `unknown` / `expired` 不渲染可见胶囊（按规则 16 保留常驻空 `sr-only` `role="status"`）；其余相位渲染对应 `canvas.save.*` 文案键；`saved` 与 `blocked` 在相位不变时持续渲染，不因计时器自动隐藏。
15. 每个可见相位都有文字；圆点 `aria-hidden`；胶囊无 `aria-live`。
16. sr-only `role="status"`：`blocked` / `offline` 各播报一次；其余相位为空。
17. `unsaved` 立即出现；`saving` 在 500ms 后出现，且显示后最短保留 200ms（转 `saved` 时）；转 `blocked` / `offline` / `expired` 时立即切换或隐藏；卸载后无计时器再触发。
18. 父级连续 10 次重渲染且相位不变时指示器提交 0 次；相位变化只重渲染指示器。
19. 不调用 `useOnlineStatus`，不读取 `navigator.onLine`。
20. 明暗主题 token 可读；`prefers-reduced-motion` 下无脉冲。

### 架构与契约

21. `features/canvas/index.ts` 无新增导出；`persistence` 不导入 React；无循环依赖；架构测试通过。
22. `zh-CN.json` / `en-US.json` 的 `canvas.save` 键集合一致；`common.saved` 保持原值且仍只被设置场景使用。
23. 保存协议无回归：三档防抖、`MAX_SAVE_WAIT`、`flushAndWait`、401 / 409、keepalive 增量回落既有测试全部通过。
24. 删除 `OfflineIndicator` 与 `use-online-status.ts` 后无残留引用；在 `web/src` 的 `.ts` / `.tsx` 源码与测试中检索 `offline.label` / `offline.tooltip` / `useOnlineStatus` 为 0（排除 `specs/`、`reference/`、JSON 与构建产物）。

### 检查命令（串行）

- `cd web && npx tsc --noEmit`
- `cd web && npm run lint`
- `cd web && npx vitest run --maxWorkers=1 --minWorkers=1`

### 手工走查（用户确认）

25. 持续编辑时保持「未保存」；快速离散操作允许短暂出现「未保存」，保存完成后回到「已保存」，任何时刻不得出现「已保存」与未落库改动并存；请求超过 500ms 时可观察到「保存中」。
26. 断网：未编辑即显示离线；断网编辑后恢复网络自动补存；离线且有未保存内容时关闭页面出现浏览器提示。
27. 两个标签页打开同一画布：被驱逐窗口只有过期弹窗、无保存徽标；刷新后恢复。
28. 窄视口（375px 与 `<768px`）、明暗主题、reduced-motion、英文界面下文案与布局正常；状态文字始终位于项目卡片内、项目名之后且完整可读；卡片按内容自适应宽度（`min-w-[280px]`、`max-w-[calc(100vw-42px)]`），名称区先收缩、项目名在卡片内截断、名称区不足 `6rem` 时隐藏编辑入口；Agent 行下移（含资源管理器打开且 `<1024px`，以及 `768–1023px` 时左上行按抽屉宽度派生值收窄）；状态文字不得退化为仅图标、省略号或溢出隐藏，也不得被卡片溢出内容覆盖或截获指针。

## 已确认事项

2026-11-13 用户确认本 Spec，并裁定：能对齐即梦画布语义的按对齐处理，其余采用有据可查的行业成熟方案。以下「对齐」均指语义层，不声称像素级复制。

1. **合并离线指示器（对齐即梦）。** 同一位置只保留一个保存语义徽标，删除 `OfflineIndicator` 与随之失去引用的 `useOnlineStatus`（规则 9、范围）。即梦正常画布不存在第二条常驻离线徽标，连接异常使用条件性提示；本项目的离线语义由 SaveManager 的 `offline` 单一表达。删除后不保留转发文件或兼容导出。
2. **`saved` 常驻（对齐即梦）。** 即梦标题保存文本没有计时自动隐藏；Google Docs 的常驻云图标亦为旁证。本项目显示为 muted 胶囊、无彩色圆点，使「没有徽标」不再需要被解释为已保存。与即梦的差异：即梦标题文本只在画布有节点时渲染，本项目指示器只由相位决定是否渲染，不依赖节点数量。
3. **`blocked` 常驻（永久性对齐即梦）。** 即梦阻塞态没有自动清除或超时，必须由用户动作解除；本项目同样常驻，文案「登录已失效，保存暂停」，直到下一次编辑 / flush / 重新握手清除。视觉差异：即梦使用 10px 次要色文本，本项目的警示圆点属于本项目 + 行业错误提示取舍（Figma / Excalidraw 类），不声称与即梦视觉一致。实现配套：`handleCanvasHandshake` 的 `held === lease` adopted 分支当前不清除 `authBlocked`，需新增 `notifySessionValid(projectId)`（只清 `authBlocked` 并发布，不重建基线、不自动保存），并补回归测试。
4. **卸载提示包含 `saving`（用户可见语义对齐即梦）。** 只要存在无法确认落库的改动就提示；即梦的离开条件还包含 `recoveryState === 'needs_refresh'` 与文本编辑会话脏状态，本项目映射为 `dirty || saving`（同一所有者、非 `expired`）。Excalidraw 在 beforeunload 中同样把在途保存计入。本项目没有 journal，无法逐条等价，这是适配而非复制。
5. **防闪烁（行业成熟方案）。** 即梦的 pending 状态包含 journal 终结，状态天然持续，不能类比本项目的短请求；即梦也未采用延迟 / 最短显示。采用进度指示器通行规范（Dynatrace 等）：`saving` 延迟 500ms 显示、显示后最短 200ms；`unsaved` 立即显示；`saved` 常驻。旧草案的 150ms 双延迟会让首次 dirty 后仍短暂显示「已保存」，已废弃。`blocked` / `offline` 立即显示，不受最短显示限制。
6. **删除 `offline.*`（项目规则）。** `offline.label` 与无引用的 `offline.tooltip` 在删除 `OfflineIndicator` 后失去引用，按「无引用键删除」清理；`error.upload.offline` 等其它离线文案保留。该决定与即梦把保存文案归入画布语义的做法一致，但删除范围仅限本项目失去引用的顶层 `offline` 段。
7. **`canvas.save.saved` 独立键（项目 i18n 归属决定）。** 不复用 `common.saved`；后者继续服务设置场景，不受本能力影响。这样画布语境可独立调整文案，也避免两个场景的文案变更互相牵连。不声称与即梦内部键名存在对应关系。
8. **窄视口不允许仅图标（对齐即梦的负向约束 + 项目无障碍约束）。** 即梦在宽度不足时整体隐藏 metadata，不退化为仅图标，也没有 aria / tooltip 兜底；本项目保留状态文字，因为保存状态是关键提示，不应隐藏，且「状态必须由文字表达」是既定无障碍规则。Figma / tldraw 的图标 + tooltip 模式需要新增浮层与无障碍名称，本期不采用。若走查发现重叠，只允许调整布局或缩短文案。
9. **验收 14 与规则 16 的冲突裁定（2026-11-13 用户确认）。** `unknown` / `expired` 的「渲染 null」按「不渲染可见胶囊」理解；指示器始终挂载同一个空的 `sr-only` `role="status"` 节点，`blocked` / `offline` 时填入文案并播报。保留常驻节点是为了让 live region 在文本变化前已存在，避免部分读屏在节点新建时漏播；不追求字面意义的无 DOM。验收 14 已按此措辞更新。
10. **胶囊位置改到左上工具条右侧（2026-11-13 用户确认）。** 用户明确：胶囊在宽窄屏都放在左侧整个工具条的右面。原「Agent 按钮左侧」布局废弃；窄屏（`<768px`）为避免胶囊被 Agent 覆盖，Agent 行下移到工具条下方一行。该调整同时修复此前走查发现的长项目名 / 英文 `Unsaved` 被胶囊遮挡的问题。该放置位置后由事项 13 调整为卡片内部、标题之后；Agent 下移与抽屉断点规则沿用。
11. **指示器改为纯文字（2026-11-13 用户提出）。** 去掉边框与背景，只保留状态文字与圆点，与即梦标题旁的保存文本一致；下文「胶囊」为历史称呼，均指该纯文字指示器。纯文字裁定不变，位置后由事项 13 调整到卡片内标题之后。
12. **`saved` 保持无圆点（2026-11-13 用户确认）。** 「已保存」不使用绿色或其它常驻圆点；圆点只编码需要注意的相位（`saving` / `unsaved` / `offline` 琥珀，`blocked` 红色），静息态只用弱化文字。若未来需要正向反馈，应作为一次性过渡提示另行确认，不得改为常驻绿点。
13. **保存状态移入项目卡片、位于标题输入框之后（2026-11-13 用户提出）。** 用户对比截图后提出将「已保存」放到项目名之后；采用 `ProjectToolbar` 的 `trailing` 槽位实现，状态仍是自行订阅的叶组件，工具栏不感知相位。卡片改为内容自适应宽度：名称区上限 `10rem` 并可收缩，状态文字 `shrink-0`，卡片随状态文案增长但不超过 `100vw - 42px`；名称区不足 `6rem` 时隐藏悬停编辑入口。状态文字随之成为卡片表面的一部分：其区域点击落在卡片上，不再穿透画布；行内空白仍穿透。该决定取代事项 10 的「卡片右侧独立行」放置方式，并保留其 Agent 下移规则。

## 当前状态

- 状态为「已实现」（2026-11-14 用户确认验收）。实现方案于 2026-11-13 经用户确认：8 项待确认事项已按「能对齐即梦语义的按对齐，其余采用行业成熟方案」裁定；4 处实现前事实修订已回写；同日另裁定验收 14 按「不渲染可见胶囊、保留常驻空 live region」理解，保留当前实现；用户随后提出将状态移入项目卡片、位于标题之后（已确认事项 13），已按该布局修订规则、实现与走查证据。2026-11-14 用户确认走查结果与当前布局，实现代码已提交为 `e3e4ec82`（push 尚未执行），状态同日回写为「已实现」。
- 已实现（已提交 `e3e4ec82`）：
  - `save-manager.ts`：`CanvasSavePhase`、`getSavePhase()` / `subscribeSavePhase()`、`savingProjectId`、`publishSavePhase()`、`notifySessionValid(projectId)`、`notifyEvicted(projectId)`、`setUnloadPromptEligible()`；基线建立时注册生命周期监听并采样在线状态；`beforeunload` 离开确认先判定后 flush；保存归属判定收敛为单一 `isSaveOwnedBy(projectId)`；`resetForProjectSwitch` 同步清空 `savingProjectId`。
  - `session-events.ts`：同租约 adopted 分支调用 `notifySessionValid(projectId)`，只解除 401 暂停；evict 路径调用 `notifyEvicted(projectId)`，旧项目迟到事件按归属过滤。
  - `CanvasRoot.tsx`：挂载 / 卸载切换卸载提示资格。
  - `CanvasSaveStatusIndicator.tsx`：`useSyncExternalStore`、500ms 延迟 / 200ms 最短显示、`data-phase`、sr-only `role="status"`；经 `ProjectToolbar` 的 `trailing` 槽位渲染在卡片内部、项目名之后；`CanvasPanels.tsx` 左上容器 `pointer-events:none`、项目卡片 `auto`、状态文字自身穿透；右上只保留 Agent，`<768px` 整行下移，资源管理器打开且 `<1024px` 时同样下移，`768–1023px` 时 Agent 位于工具条下一行、左上行宽度上限由 `DRAWER_WIDTH + 12px` 经 CSS 变量派生。
  - `ProjectToolbar.tsx`：新增 `trailing` 槽位；项目名区为 `w-40` 可收缩容器查询宿主，名称区不足 `6rem` 时隐藏悬停编辑入口；卡片自适应宽度（`w-fit`、`min-w-[280px]`、`max-w-[calc(100vw-42px)]`）并 `overflow-hidden`；移除自身 30px 外边距。
  - 删除 `OfflineIndicator.tsx` 与 `use-online-status.ts`；i18n 新增 `canvas.save.*`，删除失去引用的顶层 `offline` 段，保留 `error.upload.offline` 与 `common.saved`。
- 已验证事实（2026-11-13）：`cd web && npx tsc --noEmit` 通过；`cd web && npm run lint` 0 error（6 个既有 `@next/next/no-img-element` warning）；聚焦用例 78 通过；完整 web 套件 225 个文件 / 1812 个用例全部通过（`npx vitest run --maxWorkers=1 --minWorkers=1`，248.52s）。随后完成四维对抗审查（SaveManager、卸载生命周期、指示器、Spec/架构），当轮无确认缺陷；仅记录验收 14 与规则 16 的既有文本冲突（见下）。审查后补充 5 个验收 / 回归测试：指示器父级重渲染 bail、`blocked` + dirty 卸载提示、`offline` + dirty 卸载提示、旧项目迟到 401 不毒化新画布相位、旧项目迟到 401 不吞掉新项目补存诉求；其中迟到 401 用例先复现真实缺陷（响应到达前已切换项目时，`authBlocked` 被无条件置位使新画布误报 `blocked`），已按规则 3 增加所有者归属过滤并修复。最终 `npx tsc --noEmit`、`eslint`（改动文件）通过；完整 web 套件 225 个文件 / 1817 个用例全部通过（`npx vitest run --maxWorkers=1 --minWorkers=1`，244.50s）。布局 / 纯文字 / 浅色对比度调整后再次执行 `npx tsc --noEmit` 通过、`npm run lint` 0 error（同 6 个既有 `@next/next/no-img-element` warning）、完整 web 套件 225 个文件 / 1817 个用例全部通过（`npx vitest run --maxWorkers=1 --minWorkers=1`，255.53s）。最终对抗审查的四项修复（抽屉打开时 Agent 下移、卡片裁切与窄容器隐藏编辑入口、Spec 修订、卸载计时器断言）后再次执行 `npx tsc --noEmit` 通过、`npm run lint` 0 error（同 6 个 warning）、聚焦指示器用例 9 通过、完整 web 套件 225 个文件 / 1817 个用例全部通过（`npx vitest run --maxWorkers=1 --minWorkers=1`，249.77s）。保存状态移入卡片标题之后，最终代码再次执行 `npx tsc --noEmit` 通过、`npm run lint` 0 error（同 6 个既有 `@next/next/no-img-element` warning）、聚焦指示器用例 9 通过、完整 web 套件 225 个文件 / 1817 个用例全部通过（`npx vitest run --maxWorkers=1 --minWorkers=1`，246.72s）。
- 手工走查（2026-11-13，本地 dev 预览，用户授权）：已通过——明暗主题（胶囊可见、配色正常）；保存状态机（500ms 内完成不出现「保存中」；延迟请求可见「保存中」+ 脉冲圆点与 200ms 最短展示；连续 8 次编辑间隔 250ms 时只在「未保存 / 保存中」间切换，最后编辑落库后才「已保存」，未出现「已保存」与未落库改动并存）；离线（未编辑即 offline、离线编辑后恢复在线自动补存、离线且有未保存内容时合成 `beforeunload` 被阻止）；过期（注入 409 走同一客户端路径后无胶囊、出现 Session expired 弹窗、Refresh page 后恢复「已保存」）；指针穿透（旧布局记录：胶囊与内容行 `pointer-events:none`、仅 Agent `auto`；胶囊中心命中画布。该指针语义随事项 13 移入卡片后已改变，现行语义见下文当前布局复验）；资源管理器抽屉开合时 Agent 位置不变（旧布局下胶囊固定在右上；新布局见下条）；英文界面（Saved / Unsaved / Saving，宽度 60 / 91 / 80px，无换行、省略号或溢出）；窄视口 375×812（旧布局：胶囊单行、未退化为图标、与 Agent 间距 7.6px）。
- 手工走查发现与后续裁定（2026-11-13）：375px 下旧布局（胶囊在右上、与 Agent 同行）的左上项目卡片固定 `w-[280px]`（x=30..310），与右对齐的「胶囊 + Agent」行水平重叠；长项目名被「保存中」胶囊覆盖 80px，英文 `Unsaved` 覆盖名称尾部 / 下拉箭头 15px。用户先决定暂不修复，随后改为将胶囊移到左上项目工具条右侧、宽窄屏一致（见已确认事项 10），该布局从结构上消除遮挡；该布局的复验见下条（后又被事项 13 取代）。另观察：窄视口下左下控制条宽 409px，超出 375px 视口，属既有布局问题，与本能力无关。
- 前一轮布局复验（2026-11-13，状态在项目卡片右侧，已被已确认事项 13 取代）：桌面 1558×900 卡片 30..310、状态 318..354、Agent 1432..1528；375×812 卡片 30..310、状态 318..354、Agent 下移 249..345（y=74..114）；断点 767px Agent y=74、768px y=30；抽屉打开 1558 时卡片 / 状态右移 360px、Agent 不动；英文离线 375 卡片收缩到 126、名称 34、状态 199 完整并穿透；320 卡片 71、名称 0、编辑入口隐藏，无横向滚动。该轮审查修复抽屉打开 768–1023px 重叠、≤337px 编辑按钮溢出、Spec 旧文本与卸载计时器空断言；后因用户要求将状态移入标题之后而重新布局。
- 当前布局复验（2026-11-13，状态在项目卡片内、项目名之后；本地 dev 预览，Agent 走查；用户已于 2026-11-14 确认）：
  - 桌面 1558×900，「已保存」：卡片 30..310（280px）、名称区 100..260（160px）、状态 265..301（36px），三者同卡；Agent 1432..1528（y=30..70）。状态中心命中卡片内尾部包装层（非画布），行内空白与卡片右侧命中 `react-flow__pane`。编辑态下输入框 100..260、状态 264..463，输入框聚焦，状态紧随其后。
  - 英文离线（真实 `offline` 相位）1558×900：卡片 30..472（442px）、名称区 160px、状态 264..463（199px），卡片随状态增长；1024×900 抽屉打开：卡片 390..832、状态 624..823、Agent 898..994（y=30..70），水平间距 66px。
  - 抽屉打开 800×900：左上行 360..788（428px，`100vw - (DRAWER_WIDTH + 12px)`）、卡片 390..788（398px）、名称区 460..576（116px）、状态 580..779（199px 完整）；Agent 下移 674..770（y=74..114），与卡片不同行。768×900 抽屉打开：行 360..756（396px）、卡片 390..756（366px）、名称区 460..544（84px，编辑入口隐藏）、状态 548..747 完整；Agent 642..738（y=74..114）。
  - 768×900 抽屉关闭：卡片 30..472（442px）、状态 264..463、Agent 642..738（y=30..70），无重叠；767×900 关闭时 Agent 下移 y=74。375×812 英文离线：卡片 30..363（333px）、名称区 51px（编辑入口隐藏）、状态 155..354（199px 完整），Agent 249..345（y=74..114），无横向滚动；320×812：卡片 30..310（280px，`min-w` 下限）、名称区 2px、状态 104..303 完整，行 0..308，无横向滚动。
  - 主题对比度：`saved` 在卡片 `bg-card/70` 合成背景上，深色 muted 实测 7.13:1、浅色 `text-foreground/70` 实测 7.85:1，均高于小字 AA 4.5:1；走查结束恢复深色 / 中文 / 在线。
- 当前布局复验补测（2026-11-13，第二轮走查；用户已于 2026-11-14 确认）：
  - 抽屉打开 1558：左上卡片 x=390、行宽上限 1546px；1024：行宽上限 1012px、卡片 390..670、Agent 898..994（y=30..70）；800：行宽上限 428px、Agent 674..770（y=74..114）；768：行宽上限 396px、Agent 642..738（y=74..114）。767 关闭：行宽上限 755px、卡片 30..310、Agent 641..737（y=74..114）；375 行宽上限 363px；320 行宽上限 308px、状态 267..303，各断点均无横向滚动。
  - 离线相位（合成 `offline` 事件）320×812：相位 `offline`、中文「网络异常，保存已暂停」单行 136px（167..303）、琥珀圆点、`role="status"` 文本同步；恢复 `online` 后回到 `saved`。
  - 英文 320×812：`saved` = "Saved"（34px，269..303）；英文离线 "Network error — saving paused" 199px 单行（104..303，高 16px），无横向滚动。
  - 明暗主题：经画布控制条真实 `ThemeToggle` 切换（非 DOM 改类）——浅色下 `<html>` 与 `.react-flow` 均为 `light`，`saved` 文字为前景 70% 透明度（计算值 `oklab(0.145 … / 0.7)`），离线文字为实心前景（`lab(2.75 0 0)`）、圆点 `amber-400`（`lab(80.16 16.60 99.21)`），320 下状态 267..303、无横向滚动；走查结束已切回深色。
  - 运行时错误：`window.__walkErrors` 全程为空；对当前页面回放 `pagehide` / `visibilitychange` 后控制台错误计数保持 245 不变（均为硬刷新前 HMR 旧实例的历史条目），当前 dev chunk 已包含 `isSaveOwnedBy` 方法定义。
- 未验证 / 未完成（作为已知残余风险记录，不阻塞本次验收）：真实浏览器关闭对话框（仅验证 `beforeunload` 的 `defaultPrevented`）；真实 reduced-motion 仿真（预览工具不支持，仅验证 `motion-safe:animate-pulse` 类与正常模式计算样式；jsdom 只断言该类存在，未仿真 reduced-motion）；双标签页 SSE 驱逐触发链路（仅以 409 注入验证过期后的界面与刷新恢复）；`navigator.onLine` 与真实可达性的一致性；401 `blocked` 的实机走查（会触发全局登录失效，未操作）。另：预览面板宽度为 375px，1558 / 1024 / 800 / 768 / 767 / 320 视口以 DOM 几何验证，截图仅覆盖面板可见的左侧裁切区域。2026-11-14 用户确认走查结果与当前布局，状态回写为「已实现」。
- 审查后根因修复（2026-11-13，`/code-review` 未提交差异，用户要求根因修复）：
  - `SaveManager` 保存归属判定收敛为 `isSaveOwnedBy(projectId)`，`getSavePhase` 与 `hasUnsafeLocalChanges` 共用；`resetForProjectSwitch` 同步清空 `savingProjectId`，旧项目在途保存不再把同项目重进的新会话误标为 `saving`。
  - `notifySessionValid(projectId)` / `notifyEvicted(projectId)` 均按 `getCanvasProjectId()` 过滤旧项目迟到事件；`notifyEvicted` 在 owner 尚未建立时保留全局过期语义。
  - `CanvasPanels.tsx` 左上行宽度上限改由 `DRAWER_WIDTH + PANEL_RIGHT_INSET` 经 CSS 变量派生，删除硬编码 `372px`；撤销未要求的 Agent 行 `pointer-events` 改动与无效 `gap-2`。
  - 测试补齐：同租约 / 旧项目 `notifySessionValid` 订阅与无通知断言、非法载荷与协议不一致不调用 `notifySessionValid`、`pagehide` 在途保存不发第二个 keepalive 请求、A→B→A 不再误报 `saving`、旧项目迟到 evict 不污染新画布、监听注册用例改为 `vi.resetModules()` 隔离；生命周期用例不再改私有 `offline` 字段。
  - 修复后验证：`npx tsc --noEmit` 通过；`npm run lint` 0 error（6 个既有 `@next/next/no-img-element` warning）；聚焦 6 个用例文件 101 个用例通过；完整 web 套件 225 个文件 / 1821 个用例全部通过（`npx vitest run --maxWorkers=1 --minWorkers=1`，242.67s）；浏览器复验派生宽度：1558 关闭 1546px、800 抽屉 428px、768 抽屉 396px、767/768 关闭 755/756px、375/320 363/308px，Agent 在 `<768px` 与抽屉打开 `<1024px` 时下移一行，320 无横向滚动。热更新中途的旧模块实例曾报 `isSaveOwnedBy is not a function`，硬刷新后事件回放无错误（开发态残留，非代码缺陷）。
- 第二轮独立审查与修复（2026-11-13，四维只读审查 + 对抗复核，8 个 agent）：确认并修复以下问题：
  - **Agent 入口命中回归**：`CanvasAgentEntry` 内层行在删除 `OfflineIndicator` 时一并丢失 `pointerEvents:"auto"`，外层 Panel 的 `none` 继承到整棵按钮子树，鼠标 / 触摸无法打开 Agent 抽屉（仅键盘可用）。已恢复行内 `pointer-events: auto`；浏览器实测按钮计算值 `auto`、命中点落在按钮内、点击后 Agent 抽屉打开。
  - **同项目重进的会话归属**：`projectId` 无法区分 A→B→A / A→列表→A 的前后会话，上一会话在途请求的迟到 409 会误置新会话 `expired`、迟到 401 误置 `blocked`、迟到失败误置 `dirty`。新增 `sessionEpoch`（`resetForProjectSwitch` 递增），派发时定格；`dirty` 恢复、401、409 与基线回写统一经 `isCurrentSession(projectId, sessionEpoch)` 判定。revision 回写保持单调保护，不受代际过滤影响。
  - **测试缺口**：A→B→A 用例补齐迟到成功 / 409 / 401 / 5xx 四种终态断言；`use-canvas-session.test.ts` 断言 `notifyEvicted(projectId)` 实参且同租约重连不重建基线；新增 `save-manager-ownerless.test.ts` 覆盖无所有者时的离开确认与保存派发；`CanvasRoot.contract.test.tsx` 覆盖卸载提示资格的挂载 / 卸载 wiring。
  - **Spec 文本矛盾**：转换表 `project-restored` 行与异常表「无主 dirty」行的相位结论已对齐规则 2/3 与实现（`unknown`）。
  - 第二轮复核追加修复：`saveToApi` 在写锁内、读取 baseRevision / lease 前再次校验代际，排队到切换之后的旧快照不得携带新会话凭据发出（否则会覆盖刚采纳的服务端内容）；A→B→A 成功变体改用可区分的新会话基线内容断言，锁住「迟到成功不得覆盖基线」；指示器新增「`navigator.onLine === false` 时仍按 SaveManager 相位显示」用例；旧布局走查记录的指针语义标注为历史记录。
  - 修复后验证：`npx tsc --noEmit` 通过；`npm run lint` 0 error（同 6 个既有 warning）；聚焦用例复跑通过（并发 / 指示器 / ownerless / CanvasRoot 契约）；完整 web 套件 226 个文件 / 1828 个用例全部通过（`npx vitest run --maxWorkers=1 --minWorkers=1`，249.51s）；浏览器点位验证见上。
- 实现说明：隐藏相位（`unknown` / `expired`）不渲染可见胶囊，但按规则 16 保留同一 `sr-only` `role="status"` 节点；验收 14 的「渲染 null」按「不渲染可见胶囊」理解，2026-11-13 用户确认保留该实现。显示状态机只使用组件内显示状态（上一非 `saving` 相位 + `saving` 是否可见），不复制 SaveManager 语义。内部导航丢数据窗口仍是已知限制，修复需另立 flush outcome Spec。
- 实现代码已提交（`e3e4ec82`，2026-11-14 经用户确认），验收标准（含用户对当前布局的人工确认）已通过，状态同日回写为「已实现」；push 尚未执行。

# 画布缩放手势会话（Resize Gesture Session）

状态：已实现（2026-11-02）

承接 `specs/canvas-drag-preview-session.md`：该 Spec 的非目标明确把节点缩放排除在外（「`nodes/ResizeHandle.tsx` 仍是逐帧写 store 的独立路径，如需优化另行 Spec」）。拖动与框选已改为手势会话，缩放是同一根因下最后一条「每次指针移动写受控 store」的指针路径。

## 目标

把节点/组缩放从「每次指针移动写受控 store」改为「缩放期只写 DOM 预览、松手一次提交」：

- 缩放期间 `nodes` 引用保持不变，画布外壳、节点树与全部按 `nodes` 引用缓存的派生不随指针帧重算；
- 指针位置帧按动画帧合并，每帧最多一次 DOM 写入；
- 接管 React Flow 的尺寸回传，消除「DOM 预览 → ResizeObserver → `dimensions` 变更 → 再写一次 store」的第二条逐帧写链；
- 松手时按最终几何一次提交（含实测尺寸），最小尺寸、缩放锁定、历史与自动保存语义与现状一致；
- 组与文本节点的现有交互语义不变：仅右下角手柄、组成员不随右下角缩放移动、组节点无连线。

## 现状与已验证事实

> 行号为调查时（HEAD `bb8acce3`）的位置。

### 1. 现有缩放链路

- 手柄只在节点被选中时挂载（`nodes/SelectionResizeHandle.tsx:13-16`）；当前唯二入口是组节点（`nodes/GroupNode.tsx:106-110`，`corner="bottom-right"`，最小尺寸由成员派生）与文本节点（`nodes/TextNode.tsx:236-240`，`corner="bottom-right"`，常量最小尺寸）。**没有任何调用方传入其它角、`lockAspectRatio` 或 `aspectRatio`**，四角几何、宽高比锁定与组 top/left 成员位移补偿均为不可达分支。
- `pointerdown`（`nodes/ResizeHandle.tsx:52-90`）：`stopPropagation` / `preventDefault` / `setPointerCapture`，按 `[data-id]` 查询 wrapper，取 store 节点与 `style.width/height`（缺省回退 `rect / zoom`），锁定按下时 zoom，压入历史快照，清空「是否变化」标记。
- 每次 `pointermove`（`:92-161`）同步计算新尺寸并写 store，无 rAF 合并：
  - 组：`nodes.map` 全量映射 + `shiftGroupMembers` + `setNodes`（`:133-153`），随后 `markDirty()`；
  - 非组：`updateNodeVisual({ style, position, skipHistory: true })`（`:155-160`），内部 `set` 后 `markDirty()`。
  - 最小尺寸 `Math.max` 与 `Math.round` 在每帧执行；右下角拖动时 `position` 不变。
- `pointerup` / `pointercancel`（`:163-171`）：移除监听；只要过程中出现过尺寸变化就压入一条历史快照。`pointercancel` 与 `pointerup` 走同一分支（等价于提交当前预览）。

### 2. 每帧成本链（结构分析，未做运行时采样）

- `setNodes` 每次都执行 `assertUniqueNodeIds` 与 `orderGroupsBeforeMembers`（`stores/canvas-store.ts:394-399`），两者都是 O(N)。
- 每次 `setNodes` 都产生新的 `nodes` 引用：`getCanvasDerived` 的 `derivedCache` 与 `getGroupMembership` 的 `membershipCache` 均按引用失效（`shared/canvas-derived.ts`），节点索引、选中集、选中框、全边高亮扫描、rail 宽度与组成员关系每帧全量重建。
- `InfiniteCanvas` 订阅 `s.nodes`；受控 React Flow 在 props 引用变化后于被动 effect 中 `adoptUserNodes`（O(N) lookup 拷贝），`renderedNodes` 订阅再触发一轮节点树渲染。即每个指针帧至少两轮 React 提交。
- **尺寸回传形成第二条写链**：store 尺寸变化 → wrapper 尺寸变化 → React Flow `useResizeObserver` 调 `updateNodeInternals(updates, force: true)` → 内部 lookup 替换并发出 `dimensions` 变更（不含 `setAttributes`）→ `handleNodesChange` 把 `dimensions` 归入 `otherChanges`（`hooks/use-canvas-node-changes.ts:78-84`）→ `applyNodeChanges` 写入 `measured` → 再次 `setNodes`。因此一次指针移动可能产生两次 store 写入与额外的 React 提交。
- 结论：缩放卡顿与框选/拖动同源——「每个指针帧写受控 store 并触发两轮 React 提交」；组缩放还叠加 O(N) 归一化、派生/成员关系重建与大面积半透明组体逐帧重绘。本 Spec 消除写 store 与 React 提交链，不消除组体自身的布局/重绘成本。

### 3. React Flow 机制（12.12，已验证）

- wrapper 的行内尺寸来自 `node.width ?? node.style?.width`（`@xyflow/react` 的 `getNodeInlineStyleDimensions`）。正常的 ResizeObserver 尺寸变更只写 `measured`，不写顶层 `node.width`；因此会话直接写 wrapper 行内 `width/height` 后，即使 NodeWrapper 因内部 lookup 更新而重渲染，只要 React 的 style prop 取值未变就不会重写这两个属性，预览不会被覆盖。
- `updateNodeInternals` 同步更新内部 `nodeLookup` 条目的 `measured` 与 `handleBounds`，调用 `set({})` 并发出 `dimensions` 变更。边组件 `EdgeWrapper` 订阅对应 lookup 条目并按 `handleBounds` 重算端点几何；节点编辑面板 `NodeToolbar` 以 `measured.width/height` 比较。因此缩放文本节点时其连线与所有节点的编辑面板会随预览自动跟进，会话不写第二套几何。
- 组节点没有 React Flow 连线（`GroupConnectRail` 是普通 div，不是 RF Handle），组缩放不影响任何边几何。
- `adoptUserNodes` 直接用 `userNode.measured` 生成内部 `measured`；`parseHandles` 仅在 `userNode.measured` 存在时保留此前的 `handleBounds`（`@xyflow/system` 的 `adoptUserNodes` / `parseHandles`）。预览期 DOM 已到终值，提交后不会再触发 ResizeObserver；**若提交不写最终 `measured`，内部实测会被 store 的旧值覆盖（或被重置为未测量）**，节点编辑面板、选中框与所有 measured 优先的消费方都会用错尺寸。
- measured 优先的消费方：`shared/node-size.ts`、`shared/center-node.ts`、`hooks/use-canvas-image-lod`、`hooks/use-canvas-media-priority`。组/文本节点本身不需要逐帧实测，但提交后必须一致。

### 4. DOM 归属与释放

- 预览期 React 的 style prop 仍是旧值，直接写行内值不会被撤销；提交时 store 写入终值，React 下一次渲染写入同一终值，行内值自此由 React 接管。
- **提交后不能清除行内 width/height**：React 不会重写「虚拟 DOM 未变化」的 style 值，清除会让节点失去尺寸而塌缩。取消路径必须把行内值恢复为当前 store 节点的显式尺寸（不存在时恢复会话开始时捕获的原始行内值）。

### 5. 可复用件

- 会话模式：`DragPreviewSession`（`drag/drag-preview-session.ts`）的 rAF 合并、DOM 契约、`syncRenderedNodes` 采用后释放、`cancel/dispose` 生命周期；`root/CanvasSurface.tsx:199-218` 的实例创建与布局副作用接线。
- 父级注入：`<ReactFlow>` 已由 `BatchConnectContext.Provider` / `CanvasMediaLoadingProvider` 包裹（`InfiniteCanvas.tsx:1116-1119`），缩放会话可用同模式的新 Context 暴露给节点内手柄。
- 历史与快照：`takeCanvasSnapshot`、`useHistoryStore`、`markDirtyImmediate`（`stores/canvas-store.ts:116-122`）。
- `shared/group-membership.ts` 的 `isGroupNode` 仅用于会话测试与语义说明；右下角收窄后缩放路径不再需要组成员补偿。

## 范围

- 新增缩放手势会话（指针生命周期、rAF 合并、DOM 预览、尺寸回传接管、提交、取消、释放）。
- 组节点与文本节点的右下角缩放。
- 提交写入口径（`style` + `measured`）、历史与自动保存时序。
- 手柄组件与会话接线的改造、不可达分支清理。
- 单元测试、DOM 测试与既有测试更新。

## 非目标

- 节点拖动、框选、连线、选择与多选语义（分别见拖动/框选 Spec）。
- 组布局模式（`specs/canvas-group-layout.md`）、组归属判定、组框重算与空组删除。
- 新增其它角的缩放手柄或宽高比锁定交互；当前无调用方。
- 采用 React Flow 内建 `NodeResizer`：手柄视觉、命中与交互契约保持不变。
- 修改 store schema、持久化数据、接口契约或引入新依赖。
- 消除组体大面积半透明区域的布局/重绘成本（CSS 层面的单独议题）。

## 业务规则

### 1. 会话生命周期

1.1 手柄 `pointerdown` 时建立会话：保留现有的 `stopPropagation` / `preventDefault` / `setPointerCapture`，由会话持有后续指针生命周期。
1.2 会话开始时冻结：指针按下点、节点当前显式尺寸（`style.width/height`，缺省回退 `rect / zoom`）、节点位置、按下时 zoom、wrapper 元素、wrapper 原始行内 `width/height`、历史快照、最小尺寸。节点不存在或 wrapper 不存在时不建立会话。
1.3 会话在 window 上安装 `pointermove` / `pointerup` / `pointercancel`（与现状一致），并额外监听 window `blur`：`pointermove` 只记录最新指针位置并按 rAF 合并；`pointerup` 计算最终帧并提交；`pointercancel` 与 `blur` 按「提交最后一帧」结束。`blur` 是新增兜底——指针抬起可能在窗口失焦后丢失，会话若长期停留在活动状态会持续吞掉该节点的尺寸回传；按最后一帧提交既结束会话，也不留下只存在于 DOM 的尺寸。不新增 Esc 取消。
1.4 同一时刻只有一个会话；若仍处于活动状态时收到新的 `begin`，先按当前预览提交上一会话，再建立新会话。
1.5 组件卸载、项目切换或画布根节点移除时 `dispose()`：移除监听、取消未执行的 rAF、清空会话状态，不写 store、不压历史。
1.6 会话是缩放几何唯一的 store 写入口；预览帧只写 DOM。

### 2. 预览帧

2.1 每帧以「冻结起点 + 最新指针位移」计算尺寸，指针位移按按下时 zoom 换算为画布单位（与现状一致；缩放途中 zoom 变化不改变本次换算口径）。
2.2 几何与现状一致：宽 = 起始宽 + dx / zoom，高 = 起始高 + dy / zoom；分别 `Math.round` 后 `Math.max` 最小尺寸。右下角不改变节点位置。
2.3 每帧只把最终宽高写入被缩放节点的 wrapper 行内 `style.width/height`（画布单位，px）；不写 store、不 `markDirty`、不压历史。
2.4 与上一帧尺寸相同的帧跳过 DOM 写入。
2.5 预览的连带呈现由 React Flow 内部机制完成：wrapper 尺寸变化触发 ResizeObserver → `updateNodeInternals` → 边按 `handleBounds` 重算、节点编辑面板按 `measured` 跟随。会话不手工写边、标签层或面板。
2.6 预览期 MiniMap、rail 宽度、框选外框与批量接驳轨道锚点仍读取 store 几何，滞后到提交时更新（与拖动 Spec 规则 5.4 的接受边界一致）。

### 3. 尺寸回传接管

3.1 会话活动期（含提交后等待渲染层采用）内，`NodeDimensionChange` 且 `change.id === 会话节点` 的变更由会话消费，不进入 `applyNodeChanges` 与 `setNodes`；判定在 `handleNodesChange` 过滤 `otherChanges` 处（`hooks/use-canvas-node-changes.ts`）调用会话的 `isResizingNode(id)`。
3.2 其它节点的 `dimensions` 变更照常写 store（媒体加载、视频元数据等），不得一并吞掉。
3.3 消费只阻止 store 回写；React Flow 内部 `nodeLookup` 的 `measured` / `handleBounds` 已由 `updateNodeInternals` 同步更新，预览期边与面板仍然正确。
3.4 提交时写入最终 `measured`；此后会话释放，`dimensions` 变更恢复原有回写路径。

### 4. 提交

4.1 `pointerup` 时用该事件坐标同步计算最终帧并立即应用到 DOM，取消未执行的 rAF；最终帧与预览帧使用同一几何函数。
4.2 最终宽高与起始宽高相同（含被最小尺寸卡住、点按手柄未移动、拖出后回到原位）时：不写 store、不压历史、不 `markDirty`；把 wrapper 行内尺寸恢复为会话开始时捕获的原始值后释放（React 的 style prop 未变化，不会替会话重写；不恢复会让无位移的点按留下一个仅存在于 DOM 的尺寸）。
4.3 有变化时一次 `setNodes`：仅把该节点替换为 `{ ...node, style: { ...node.style, width, height }, measured: { width, height } }`，不改 `position`、`data`、`parentId` 等字段；随后一次 `markDirtyImmediate`，并压入会话开始时取得的一条历史快照。
4.4 使用 `setNodes` 而不是 `updateNodeVisual`：提交必须同时写 `style` 与 `measured`，且保持单一写入口径；不得再调用第二次 store 写入。
4.5 提交后不清理 wrapper 行内 `width/height`（React 已写入同一终值，清除会塌缩）。待渲染层采用新 `nodes`（`renderedNodes` 布局副作用中的 `syncRenderedNodes`）后释放会话与监听，不使用固定延时。
4.6 提交是唯一一次落库：历史一条、自动保存一次；预览帧不产生中间持久化。

### 5. 取消与外部写入

5.1 活动期间渲染层采用了非会话提交写入的 `nodes`（撤销/重做、生成回填、远端同步、其它节点变更等）时：
  - 被缩放节点仍存在，且其 `style.width/height`、`position`、`measured` 与会话开始时一致 → 会话继续，预览不受影响；
  - 被缩放节点几何已被外部改写或节点被删除 → 取消：移除监听、取消 rAF、丢弃未提交尺寸，不写 store、不压历史；把 wrapper 行内尺寸恢复为当前 store 节点的显式尺寸（不存在时恢复会话开始时的原始行内值），DOM 以 store 为准。
5.2 会话自身提交引起的 `nodes` 替换不算外部写入（由提交等待标记区分）。
5.3 节点在缩放中被删除时按外部改写处理：取消且不提交。
5.4 项目切换/卸载只做 `dispose()`，不恢复、不提交。

### 6. 历史、自动保存与数据

6.1 历史语义不变：按下时取快照，有最终尺寸变化时提交一条；撤销一次回到缩放前；无变化与取消不产生历史。
6.2 预览期不 `markDirty`；提交有变化时 `markDirtyImmediate` 一次，无变化不落库。
6.3 只改该节点的 `style` 与 `measured`；组成员相对位置、组归属、组框重算、空组删除均不变（右下角缩放本就不移动成员）。
6.4 数据结构、持久化与撤销/重做语义不变。

### 7. 手柄收窄（已确认决策 1）

7.1 `ResizeHandle` 固定为右下角：删除 `corner`、`lockAspectRatio`、`aspectRatio` 属性及四角/宽高比分支；保留 `nodeId`、`minWidth`、`minHeight`。
7.2 删除缩放路径中的 `shiftGroupMembers` 调用与组 top/left 原点位移补偿；`shiftGroupMembers` 仍由 `refitGroupRects` 使用（`shared/group-bounds.ts:183`），不删除该函数。
7.3 `SelectionResizeHandle` 的属性类型随 `ResizeHandle` 收窄；`GroupNode` / `TextNode` 删除 `corner` 传值，最小尺寸传值不变。
7.4 侧栏光标与手柄视觉不变（`nwse-resize`）。

### 8. 一致性

8.1 松手结果（尺寸、最小尺寸、位置、组成员、历史、自动保存）与改造前一致。
8.2 缩放期间缩放/平移画布不改变本次预览口径（zoom 在按下时锁定，与现状一致）。
8.3 不改变选择、点击、双击、拖动、框选、连线等交互；手柄仍只在选中时出现。

## 技术影响

### 新增

- `web/src/features/canvas/resize/resize-geometry.ts`：纯几何计算（起点、指针位移、zoom、最小尺寸 → 最终宽高），预览与提交共用。
- `web/src/features/canvas/resize/resize-session.ts`：会话控制器（begin / rAF preview / commit / cancel / dispose / `syncRenderedNodes` / `isResizingNode`）；依赖注入（`getNodes`、`setNodes`、`markDirtyImmediate`、`takeSnapshot`、`pushHistory`），非 React 模块。
- `web/src/features/canvas/resize/resize-session-context.ts`：会话 Context 与 `useResizeSession`（缺失 Provider 时明确报错，不做静默兜底）。
- `web/src/__tests__/features/canvas/resize/resize-geometry.test.ts`
- `web/src/__tests__/features/canvas/resize/resize-session.test.ts`

### 修改

- `web/src/features/canvas/nodes/ResizeHandle.tsx`：移除 store/历史直连与逐帧写入，改为从 Context 取会话并在 `pointerdown` 调用 `begin`；属性收窄（规则 7）；视觉不变。
- `web/src/features/canvas/nodes/SelectionResizeHandle.tsx`：属性类型同步收窄。
- `web/src/features/canvas/root/CanvasSurface.tsx`：
  - 创建并持有 `ResizeSession`（与 `dragSession` / `marqueeSession` 同模式），在依赖 `renderedNodes` 的布局副作用中调用 `syncRenderedNodes()`，卸载时 `dispose()`；
  - 用 `ResizeSessionContext.Provider` 包裹 `<ReactFlow>` 子树（与现有 Provider 同层）；
  - 经 `useCanvasNodeChanges` 的 `otherChanges` 过滤消费会话节点的 `dimensions` 变更；
  - 不新增 store action，不改 `canvas-store.ts`。
- `web/src/features/canvas/shared/group-bounds.ts`：更新 `shiftGroupMembers` 的消费方注释（不再包含 ResizeHandle）。
- `web/src/features/canvas/nodes/GroupNode.tsx`、`nodes/TextNode.tsx`：仅随属性收窄更新类型/传值，语义不变。
- 测试：新增几何与会话用例；更新受影响的手柄/节点测试。

### 依赖的 React Flow 契约（12.12，升级需重新验证）

- DOM：`.react-flow__node[data-id]` 包装元素；行内 `width/height` 可被直接写入。
- 内部机制：`getNodeInlineStyleDimensions` 以 `style.width/height` 决定行内尺寸；`useResizeObserver` → `updateNodeInternals(force)` → `dimensions` 变更（普通路径不含 `setAttributes`）；`EdgeWrapper` 按 `handleBounds` 重算；`NodeToolbar` 按 `measured` 定位；`adoptUserNodes` 采纳 `measured` 且 `parseHandles` 保留已有 `handleBounds`。
- 升级 React Flow 时必须重新验证上述契约；契约失效会表现为边/面板不跟随或提交后几何陈旧。

## 异常与边界

| 场景 | 行为 |
| --- | --- |
| 点按手柄未移动 | 无 store 写入、无历史；恢复原始行内尺寸后释放 |
| 拖出后回到起始尺寸 | 无 store 写入、无历史；预览回到起始尺寸，恢复原始行内尺寸后释放 |
| 被最小尺寸卡住 | 预览与提交均为最小尺寸；若等于起始尺寸则不提交 |
| `pointercancel` / window `blur` | 按最后一帧提交（与现状 `pointercancel` 一致） |
| 缩放中节点被删除 | 取消，不写 store、不压历史 |
| 缩放中撤销/回填/远端同步 | 被缩放节点几何未变则继续；被改写或删除则取消（规则 5） |
| 缩放中另一节点被外部写入 | 预览继续（`nodes` 引用变化不影响行内尺寸），提交时以最新数组为基准一次写入 |
| 缩放中画布卸载/切换项目 | `dispose()`，不写 store、不压历史 |
| 缩放中缩放画布 | zoom 按按下时锁定，尺寸换算口径不变（与现状一致） |
| 文本节点缩放 | 连线经 `handleBounds` 跟进；编辑面板经 `measured` 跟进 |
| 组节点缩放 | 无连线；成员不移动；组框/归属不变 |
| 提交后行内尺寸 | 保留，由 React 接管；禁止清除 |
| 尺寸回传在提交后到达 | 会话已释放则按普通 `dimensions` 处理；写入值与最终 `measured` 一致 |

## 验收标准

1. 单元测试断言：预览帧不调用 `setNodes`、不调用 `markDirty*`、不压历史；`nodes` 引用在整个预览期不变；rAF 合并后每帧最多一次 DOM 写入。
2. 提交：指针抬起恰好一次 `setNodes`，写入最终 `style.width/height` 与 `measured`，`position` 不变；一次 `markDirtyImmediate`；一条历史；无变化时零写入。
3. 尺寸回传：会话节点的 `dimensions` 变更在活动期与提交等待期被消费（不写 store），其它节点的 `dimensions` 照常写入；提交后恢复。
4. 释放：提交后待渲染层采用新 `nodes` 才释放；释放后 wrapper 行内尺寸仍等于终值（未清除）；无变化路径恢复会话开始时的原始行内尺寸；取消路径恢复当前 store 尺寸。
5. 外部写入：几何未变时缩放继续；几何被改写或节点删除时取消且零写入；会话自身提交不被误判为外部写入。
6. 取消/卸载：无残留监听与 rAF，store 未被写入，历史未新增。
7. 检查：`cd web && npx tsc --noEmit`、`npm run lint`、`npx vitest run`（单 worker、串行）通过；既有画布测试保持通过。
8. 手工走查（用户确认）：
   - 组与文本节点在 zoom 0.2 / 1 / 2 下缩放跟手，尺寸与指针位移严格按 zoom 换算；
   - 缩放中 store 位置与尺寸不变（开发者工具观察），松手恰好一次 PUT、一条历史，撤销一次精确还原；
   - 文本节点缩放时连线与节点编辑面板跟随，组缩放时成员不移动；
   - 最小尺寸、点按无历史、明暗两套主题下手柄视觉不变；
   - 组大面积缩放的主观流畅度明显改善。

## 已确认决策

用户于 2026-11-02 确认本 Spec，以下四项按建议方案确认：

1. **手柄范围收窄**：按规则 7 删除 `corner` / `lockAspectRatio` / `aspectRatio` 与组 top/left 成员补偿（不可达代码）。
2. **外部写入策略**：采用规则 5.1「被缩放节点几何未变则继续，被改写/删除则取消」，而不是拖动会话的「以新 store 重建基准」。理由：缩放的起点几何是刚性的，外部改写后继续会覆盖外部结果；无关节点的写入不应中断缩放。
3. **预览期派生滞后**：接受 MiniMap、rail 宽度、选中框/批量轨道锚点在缩放期滞后到提交（与拖动 Spec 规则 5.4 一致），不在本 Spec 中逐帧同步。
4. **取消语义**：沿用现状——`pointercancel` / 失焦按提交处理，不新增 Esc 取消缩放；若后续需要 Esc 取消（恢复起始尺寸），另行提出。

## 待确认事项

- 无未决业务规则或接口契约。

## 与现有 Spec 的关系

- `specs/canvas-drag-preview-session.md`：复用其会话模式、DOM 契约与「渲染层采用后释放」信号；本 Spec 处理该 Spec 明确排除的节点缩放。
- `specs/canvas-marquee-gesture-session.md`：同为指针手势会话，复用 rAF、`syncRenderedNodes`、取消/释放生命周期；不共享几何或命中逻辑。
- `specs/canvas-snap-alignment.md`：缩放不参与吸附与对齐辅助线，不涉及。
- `specs/canvas-undo-redo-integrity.md`：历史仍为「按下一条快照、提交一次压栈」，语义不变。
- `specs/canvas-group-layout.md`：组尺寸变化后的布局能力不变；本 Spec 不修改布局算法。

## 当前状态

- 2026-11-02 用户确认 Spec 及四项决策，状态更新为「已确认」，开始实现。
- 2026-11-02 实现完成，待手工走查：新增 `resize/resize-geometry.ts`、`resize/resize-session.ts`、`resize/resize-session-context.ts`；`ResizeHandle` 收窄为右下角并接入会话；`InfiniteCanvas` 创建会话、接管尺寸回传并包裹 Provider；`GroupNode` / `TextNode` 移除 `corner` 传值；`group-bounds.ts` 更新消费方注释。
- 2026-11-02 代码审查修复：项目切换时也释放缩放会话（`InfiniteCanvas` 以 `activeProjectId` 为依赖释放，避免会话跨项目存活）；移除无引用的 `ResizeSession.isActive()`；修正 `shiftGroupMembers` 的唯一调用方注释；几何用例补充「先取整再夹最小」（39.4 → 39 → 40）。
- 2026-11-02 复核通过：`npx tsc --noEmit` 无错误；`npm run lint` 0 error（6 条既有 `<img>` warning）；全量 `npx vitest run --maxWorkers=1 --minWorkers=1` 188 文件 / 1512 用例通过（缩放相关 24 例）。
- 2026-11-02 用户确认验收完成（含浏览器走查），状态更新为「已实现」。实现代码随 `17cd1e08` 提交（仅本地，未推送）。
- 已通过：`npx tsc --noEmit`、`npm run lint`（0 error）、`npx vitest run`（188 文件 / 1512 用例，单 worker 串行）；新增几何 5 例、会话 19 例。
- 未验证：浏览器手工走查（验收标准 8）与运行时性能主观对比；**未做运行时性能采样**，即梦缩放行为本轮未做专项对标。
- 走查通过并经用户确认提交后才更新为「已实现」。

## 调查记录

- 本仓库：`nodes/ResizeHandle.tsx`、`nodes/SelectionResizeHandle.tsx`、`nodes/GroupNode.tsx`、`nodes/TextNode.tsx`、`InfiniteCanvas.tsx`（`handleNodesChange`、会话接线、Provider 层级）、`stores/canvas-store.ts`（`setNodes` / `updateNodeVisual` / `markDirty`）、`shared/canvas-derived.ts`、`shared/group-membership.ts`、`shared/group-bounds.ts`、`shared/node-size.ts`、`drag/drag-preview-session.ts`、`marquee/marquee-session.ts`。
- React Flow 12.12：`@xyflow/react` 的 `NodeWrapper` / `getNodeInlineStyleDimensions` / `useResizeObserver` / `updateNodeInternals` / `adoptUserNodes` / `parseHandles` / `EdgeWrapper` / `NodeToolbar`，`@xyflow/system` 的尺寸变更应用逻辑。
- 既有 Spec：`specs/canvas-drag-preview-session.md`、`specs/canvas-marquee-gesture-session.md` 的会话架构与格式。

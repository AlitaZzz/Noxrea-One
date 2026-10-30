# 画布拖动预览会话（Drag Preview Session）

状态：已实现（2026-10-30）

承接上一轮画布拖动性能修复（提交 `8576129d`）：渲染边界与每帧派生已收敛，但节点拖动的位置帧仍然写入受控 store。本 Spec 处理该剩余根因。

## 目标

把节点拖拽从「每帧写入受控 store → 应用层与 React Flow 各一次 React 提交 → 位置帧重渲染」改为「拖动期只在 DOM 层预览、松手时一次提交」：

- 拖动期间 `nodes` 引用保持不变，画布节点树与外壳不随指针帧重渲染；
- 指针位置帧按动画帧合并，每帧最多一次 DOM 写入；
- 松手时按吸附后的最终几何一次性提交，松手结果与现有交互语义一致；
- 吸附、对齐辅助线、拖入组高亮、组归属、历史与自动保存规则保持不变。

## 现状与动机（已验证事实）

### 1. 拖动位置帧当前完整走 store

- `handleNodesChange` 对每个位置变更执行 `applyNodeChanges`（`web/src/features/canvas/InfiniteCanvas.tsx:436`）后 `setNodes(appliedNodes)`（`:529`），并每帧 `markDirty()`（`:533-535`）。
- `InfiniteCanvas` 整体订阅 `s.nodes`（`:145`），store 引用每帧变化 → 外壳、`getCanvasDerived`（`:168`）与全部位置相关 `useMemo` 每帧重跑。
- 受控模式下 React Flow 只在 `nodes` prop 引用变化后，于被动 `useEffect` 中 `setNodes(props.nodes)` 同步内部 lookup（`node_modules/@xyflow/react/dist/esm/index.mjs:284-322`）；用户交互的 `triggerNodeChanges` 只调用 `onNodesChange`（`:3550-3561`）。即：每帧位置 = 应用层一次 React 提交 + React Flow 一次 React 提交、两次绘制。

### 2. 拖拽链路与终止信号

- 拖动项由 `getDragItems` 决定：选中节点或点击节点，排除选中父组的子节点（`node_modules/@xyflow/system/dist/esm/index.mjs:2050-2080`）。
- 指针移动时 `updateNodePositions(dragItems, true)` 发出 `dragging: true` 的位置帧（`@xyflow/system:2209`）；结束/中止时发出终态帧 `updateNodePositions(dragItems, false)`（`:2313-2345`），且**终态帧先于** `onNodeDragStop` 回调。
- 中止路径（拖动中被删除、触摸多指）只发终态帧，不回调 `onNodeDragStop`（`@xyflow/system:2317-2325`）。
- 框选外框拖动与节点拖动走同一组回调；`getEventHandlerParams` 在无 `nodeId` 时以第一个拖动项作为 `currentNode`（`@xyflow/system:2085-2118`）。
- 组内成员不是拖动项：拖动组时成员相对坐标不变，成员绝对位置只在 `adoptUserNodes` 的 `updateChildNode` 中随父重算（`@xyflow/system:1734-1790`）；节点 DOM 是 `.react-flow__nodes` 下的扁平兄弟节点，靠 wrapper 的 `transform: translate(positionAbsolute)` 定位（`@xyflow/react:2361`）。因此拖动期不写 store 时，成员既不会进入拖动项，也不会自动跟随组位移。

### 3. 必须随拖动跟进的既有界面

- 边路径由 `DeletableEdge` 用 `insetEdgeAnchor` + `getBezierPath` 计算（`web/src/features/canvas/controls/DeletableEdge.tsx:61-67`），几何输入是 React Flow 的端点坐标；拖动期 lookup 不更新，边不会自动跟随。
- 边标签/删除按钮在 `EdgeLabelRenderer` 中，位置同样基于拖动前坐标（`DeletableEdge.tsx:201-228`）。
- 框选外框 `.react-flow__nodesselection` 的 transform 由选中节点包围盒派生（`@xyflow/react:2057-2108`）；批量接驳轨道锚在外框右缘（`web/src/features/canvas/controls/BatchConnectHandle.tsx:66-86`，锚点来自 `canvas-derived.ts:184-207`）。
- 节点编辑面板通过 RF `NodeToolbar` 门户定位，位置是屏幕坐标 `(nodeRect × zoom + viewport)`（`@xyflow/react:5101-5132`、`@xyflow/system:1547-1562`）；裁剪/标注/富文本/片段面板在拖动期仍然挂载（`web/src/features/canvas/editing/CropPanel.tsx:259`、`InfiniteCanvas.tsx:1310-1320`）。
- 选中动作工具栏在拖动期本就不渲染（`showSelectionChrome` 仅在 `idle` 为真，`hooks/use-canvas-interaction.ts:36`、`InfiniteCanvas.tsx:1326`）。
- MiniMap、rail 宽度、媒体优先级与 LOD 的派生都读取 store 几何（`shared/canvas-derived.ts:283-294`、`hooks/use-canvas-media-priority.ts`），拖动期不写 store 时只会滞后到提交。

### 4. 现有吸附/历史语义（当时实现事实；吸附部分已被 `specs/canvas-snap-alignment.md` 取代）

- 吸附仅对「拖动项 = 1」且 `snapToGrid` 开启生效，在绝对坐标空间对齐后换回相对坐标；多选与框选外框拖动不吸附（`InfiniteCanvas.tsx:446-527`）。此项为 2026-10-29 的实现事实，已被 `specs/canvas-snap-alignment.md` 规则 1–8 取代。
- 对齐辅助线由 `computeAlignment` 产生，经 `sameAlignmentGuides` 短路后才更新（`InfiniteCanvas.tsx:532`）。计算入口已迁至 `shared/snap-engine.ts`，辅助线类型与按值比较迁至 `shared/alignment-guides.ts`。
- 拖动开始时压入拖动前历史快照（`:806`），停止时处理归属、组框重算与空组删除并 `markDirtyImmediate`（`:825-886`）。
- 已验证的既有缺陷：`snapToGrid` 开启时，非拖拽位置帧（`dragging !== true`）会回退为 store 位置（`:514-523`）。本仓库键盘微移不经过该路径：`use-canvas-keyboard` → `nudgeSelectedNodes` 直接 `setNodes`（`shared/canvas-edit-actions.ts:75-93`），且 RF a11y 键盘已关闭（`disableKeyboardA11y`，`InfiniteCanvas.tsx:1130`）；`updateNodePositions(dragging=false)` 只由 RF a11y 键盘路径调用（`@xyflow/react:1730-1769`、`:2071-2107`、`:2260-2327`），在本仓库不可达。该缺陷现状下无用户可见表现；规则 6.4 按「非拖拽位置帧直接提交」修复，并为将来任何 `updateNodePositions(dragging=false)` 调用方兜底。

## 业界对标（即梦画布，静态分析）

对线上 bundle（`65cefeba57f29641.js` 等）的静态阅读（登录墙限制，**运行时行为未验证**）：

- `onNodesChange` 只处理吸附偏移，拖动位置不写受控 store；拖动会话 `begin` 快照（含每个节点的 source parentId）→ `preview` 每帧覆盖待处理帧、rAF 执行一次 → `commit` 取终态并取消未执行帧；提交完成后在下一 rAF 释放（`scheduleTerminalRelease`），期间展示层继续投影终态帧（`terminalProjectionFrame`）避免回跳。
- `preview`/`commit` 交给编辑器动作层异步执行（`featuresApi.canvas.actions.moveNodes.execute`），可返回 `previewed`/`blocked`/`cancelled`；非成功时回滚到上一快照（`restoreIfCurrent`），commit 被 `blocked` 时另调 `onNodeMoveFailure` 上报。
- 展示层按「受影响节点 + 位移」直接写 `[data-id]` wrapper 的 `style.translate`；整体同位移时优先整层平移（全部节点受影响则整图平移，否则按节点层/边层/屏幕层分别平移）；混合位移时逐节点平移，两端同位移的边平移、仅一端受影响的边经 `edgeGeometry.replaceDragPreview` 重算路径；拖动期隐藏 `.react-flow__edgelabel-renderer`，混合位移时隐藏选中框等叠层；屏幕空间叠层按 `位移 × zoom` 平移。
- 展示层用 MutationObserver 观察被平移层的子节点变化（拖动期新挂载的节点/边），动态纳入或还原。
- 键盘微移走同一会话（自定义按键处理、`disableKeyboardA11y: true`、8/80px 步长，按键全部释放后提交）；框选手势是独立会话（几何快照 + 轻量选择预览 + 拖动期隐藏聚合选中框）。
- RF 配置 `nodeDragThreshold: 4`、`autoPanOnNodeDrag: false`、`elevateNodesOnSelect: false`、节点数 > 600 才启用 `onlyRenderVisibleElements`。
- 结论：跟手差异的主因是「拖动期是否写受控 store」，而不是起拖阈值；阈值调整不在本 Spec 范围。

## 与即梦实现的差异（有意保留）

以下为即梦有、本 Spec 不照搬的部分，均为实现层或场景差异，不改变本 Spec 的对外行为：

- 键盘微移：即梦自建键盘会话（`disableKeyboardA11y: true`，8/80px 步长，按键全部释放后提交）；本仓库键盘微移由 `nudgeSelectedNodes` 直接 `setNodes` 提交（`disableKeyboardA11y: true`，不经过拖动会话；规则 6.4 的「终态帧直接提交」只对非拖拽位置帧生效）。自定义键盘处理不在本 Spec 范围。
- 动作层校验与回滚：即梦把 `preview`/`commit` 交给编辑器动作层异步执行，`blocked`/`cancelled` 时回滚展示；本仓库拖动期不写 store、提交是唯一写入口，当前没有拒绝源，不预置请求层。将来出现拒绝源（协作锁、服务端权威、权限撤销）时，只需在提交点判失败后不写 store、清预览并结束会话，插入点唯一（2026-10-29 用户确认：不引入）。
- 整层平移：即梦在整体同位移时按「整图 / 节点层 / 边层 / 屏幕层」做层平移以减少 DOM 写入；本 Spec 按受影响节点逐项写（见非目标），实测不足再评估。
- 中途挂载观察：即梦用 MutationObserver 跟踪被平移层的子节点变化；本仓库以「拖动期结构写入即重建会话」（规则 7.1）+「新挂载不进入预览」（规则 2.6、4.5）覆盖，不引入 DOM 观察。
- 拖动期组归属预览：即梦快照每个节点的 source parentId；本仓库归属仍在 `onNodeDragStop` 判定（规则 6.3），拖动期只做拖入组高亮（规则 3.4）。
- 释放时机：即梦在提交请求完成后下一 rAF 释放并继续投影终态帧；本 Spec 要求渲染层采用新位置后释放（规则 1.5，更严格，禁止固定延时）。
- 起拖阈值：本仓库 2px，即梦 4px（2026-10-29 已确认保持 2px）。

## 范围

- 节点几何拖拽的拖动期呈现与提交：单节点、多选、组拖动（含成员）、框选外框拖动。
- 拖动期 DOM 预览、rAF 合并、终态提交与释放时序。
- 吸附与对齐辅助线在预览层的计算与提交一致性。
- 拖动期跟进的面：节点 wrapper、边、边标签层、框选外框、节点编辑面板；批量接驳轨道拖动期隐藏（规则 5.1）。
- 拖动期不跟进但需在提交时更新的派生（MiniMap、rail 宽度、媒体优先级/LOD）的边界确认。
- 相关单元测试与手工走查清单。

## 非目标

- 不调整 `nodeClickDistance`（现为 3px），不改变选择/点击语义。（`nodeDragThreshold` 原为 2px；2026-10-29 用户要求降为库默认的 1px，见待确认事项 5。）
- 不改造节点缩放（`nodes/ResizeHandle.tsx` 仍是逐帧写 store 的独立路径），如需优化另行 Spec。
- 不启用 `onlyRenderVisibleElements` 或画布虚拟化。
- 不改变数据结构、store schema、持久化与自动保存协议。
- 不改变组归属判定、组框重算、空组删除的业务规则。
- 不引入协作同步/多端一致逻辑。
- 不做「整层位移」等针对超大选区的额外优化；先按受影响集合逐项写，实测不足再评估。

## 业务规则

### 1. 会话生命周期

1.1 会话在 React Flow 判定拖拽越过阈值后开始（`onNodeDragStart`，阈值为 `<ReactFlow>` 的 `nodeDragThreshold`，2026-10-29 起为 1px）；单选、多选、组拖动、框选外框拖动都产生会话。低于阈值或未移动不产生拖动帧，不产生会话。
1.2 拖动期的位置帧（`position` 且 `dragging === true`）只进入会话，不写受控 store；拖动期间 `nodes` 引用保持不变。
1.3 指针位置帧按 rAF 合并：每帧最多应用一次 DOM 预览，取该帧最新的拖动位置；预览写入使用 `style.translate`，不覆盖 React 管理的 `transform`。
1.4 终态由终态位置帧（`dragging === false`）判定：取消未执行的预览帧，按吸附后的最终几何提交一次。`onNodeDragStop` 负责归属判定与浮层清理，同时作为兜底：若会话仍未收到终态帧，以最后预览几何提交（React Flow 在 `nodePositionsChanged === false` 时只回调 stop，`@xyflow/system:2328-2345`）。
1.5 提交顺序：一次 `setNodes` → `markDirtyImmediate` → 待渲染层真正采用新位置后清除预览偏移。清除时机不得导致回跳或一帧过冲，也不允许使用固定延时兜底。
1.6 会话只管理几何。选中态、尺寸、节点数据变更仍按现状即时写入 store；吸附开关与网格设置（`snapEnabled`、`snapGridSize`）取会话开始时的设置，对齐阈值按屏幕像素除以开始时的 zoom 换算（`specs/canvas-snap-alignment.md` 规则 4）。
1.7 终态提交后清除全部预览偏移、恢复被隐藏的层、清空辅助线与拖入组高亮。组件卸载、项目切换或画布根节点移除时 `cancel()`：清除预览、丢弃未提交位移，store 不变。
1.8 提交是会话唯一的 store 写入口；将来若出现拒绝源（协作锁、服务端权威、权限撤销），在此判定失败并放弃写入、清除预览、结束会话，不另设校验层（2026-10-29 已确认）。

### 2. 受影响节点与位移

2.1 受影响集合 = React Flow 拖动项（`getDragItems` 语义）∪ 被拖动组的全部成员（组不嵌套，成员一层，`shared/group-membership.ts`）。
2.2 节点位移 = 预览帧中该拖动项的相对位置 − 会话开始时该节点的相对位置；组成员跟随所属组的位移。
2.3 拖动项之间的位移不保证相同（例如受 `nodeExtent` 夹取时），实现不得假设整体同位移。
2.4 预览只写受影响节点的 wrapper（`.react-flow__node[data-id]`）；其余节点不改动。
2.5 拖动期不使用 store 的 `dragging` 标记驱动状态；拖动节点的 grabbing 视觉由会话或容器状态保证，与现状一致。
2.6 拖动期新挂载的节点不进入预览，保持 store 位置；若挂载同时写入 `nodes`，按规则 7.1 重建会话。
2.7 拖动参考点取指针按下点，而不是 React Flow 的阈值事件点：React Flow 在越过阈值的首个指针事件才建立拖动参考点（`getDragItems` 的 `distance`，`@xyflow/system:2050-2065`；阈值判定与 `startDrag` 调用在 `2271-2320`），按下到该事件之间的指针位移会从整段拖动中永久丢失——节点以阈值事件点为抓取点跟随指针，整段拖动落后该距离（快速拖动时约为一帧的指针位移；低缩放下节点屏显更小，更明显）。会话在 `begin` 接收「按下点 → 阈值事件点」的屏幕位移（容器捕获阶段的 `mousedown`/`touchstart` 与 `onNodeDragStart` 事件点之差），按开始时的 zoom 换算为画布位移，补偿到每个预览帧与提交位置；吸附在补偿后的位置上计算。按下点必须取自 d3-drag 使用的同一事件类型：`PointerEvent` 的 `clientX` 保留小数，而 React Flow 读到的 `MouseEvent` 坐标是整数，混用会在补偿中留下亚像素误差。补偿为 0 时行为不变（2026-10-29 用户报告「快速移动、低缩放时节点落后指针」后按根因修复）。

2.8 越过阈值的事件本身不产出位置帧：React Flow 在阈值事件上先 `startDrag`（把 `lastPos` 设为该事件的指针位置），紧随的 `updateNodes` 因位置相等被跳过（`@xyflow/system:2255-2345`），节点要等下一次指针移动才首次位移——起手空等一次事件，按下即快速拖动时表现为「慢一拍」。会话把 `begin` 作为激活回调的第一件事（历史压栈、组命中索引、拖入高亮清空、交互状态派发等簿记全部后置；历史快照取 store，会话不写 store，压栈语义不变），并在 `begin` 内按基准位置补出一帧（经规则 2.7 补偿后即为指针当前位置对应的落点），同步应用，不额外占用后续 rAF 帧；该帧同时成为兜底提交的「最后预览几何」，越过阈值即松手时按补偿后的位置提交。补偿为 0 时不补帧（无可补位移）。

### 3. 吸附与对齐辅助线

3.1 吸附口径由 `specs/canvas-snap-alignment.md` 取代：唯一总开关同时控制对齐与网格，关闭时两者都不生效，开启时对齐优先、网格只在无对齐的轴并受缩放门槛约束；单选、多选、组拖动统一按移动集并集盒吸附；阈值以屏幕像素归一并有 5/8 滞回；候选排除移动集与隐藏节点；Ctrl/Meta 旁路、Shift 轴限。框选外框拖动整组移动与多选拖动一致：保持 React Flow 默认命中，外框拖动经 `onNodeDragStart` 进入拖动会话，正常走同一吸附链路（`specs/canvas-snap-alignment.md` 范围「不改动」）。
3.2 吸附与辅助线在预览几何上计算，得到该帧的吸附后位移；提交使用同一算法对终态位置计算，保证所见即所得。
3.3 辅助线不属于画布数据：不进 store、不进历史、不落库。拖动期通过独立瞬态订阅只驱动 `AlignmentGuides`，不得让 `InfiniteCanvas` 或节点树每帧重渲染。
3.4 拖入组高亮沿用现状：读取 React Flow 回调的原始拖动位置执行 `resolveDropGroupId`，仅在归属将变化时高亮（`setDragOverGroup` 的相等短路保留）。

### 4. 边

4.1 受影响边 = 起点或终点在受影响集合中的已有边；其余边不动。
4.2 两端位移相同时平移整条边（`.react-flow__edge[data-id]` 的 `style.translate`），不改路径。
4.3 两端位移不同或仅一端受影响时，按预览端点重算贝塞尔路径，写入该边内所有 `path` 的 `d`。几何必须与组件同源：会话与 `DeletableEdge` 共用同一个纯几何函数（`insetEdgeAnchor` + `getBezierPath`），端点来自边组件登记的拖动前几何，不得出现第二套几何实现。
4.4 拖动期隐藏 `.react-flow__edgelabel-renderer`（含悬浮删除按钮等标签内容），提交后恢复；不重排 `edges` 数据。
4.5 拖动期新挂载、或未登记几何的边不参与预览，提交后按 store 自然渲染。

### 5. 叠层

5.1 框选外框：全部选中节点都在受影响集合中且位移相同时，按位移平移；位移混合时隐藏，提交后恢复（与即梦一致，避免展示陈旧的包围盒）。节点左右连接轨道（`ConnectionSideRail`）与外框右缘的批量接驳轨道拖动期整体隐藏，悬停也不再触发显示：统一由容器 `data-interaction="dragging-nodes"` 的 CSS 规则关闭（节点轨道 `opacity: 0; pointer-events: none`，批量轨道排除拖动态的常显规则），会话不写两类轨道 DOM，松手后按提交位置自然恢复（2026-10-29 用户确认「一起隐藏」）。
5.2 节点编辑面板（RF `NodeToolbar` 门户，含裁剪/标注/富文本/片段等）：其节点受影响时按「节点位移 × 当前 zoom」平移，不重渲染面板组件。
5.3 选中动作工具栏在拖动期本就不渲染，不新增处理。
5.4 MiniMap、rail 宽度、媒体优先级与 LOD 读取受控 store 几何：拖动期保持拖动前状态，提交时更新。该滞后是本 Spec 接受的边界（2026-10-29 已确认）。

### 6. 历史、自动保存与数据

6.1 历史语义不变：拖动开始压入拖动前快照（`InfiniteCanvas.tsx:806`），提交不再压栈。
6.2 拖动期不 `markDirty`；提交有位置变化时 `markDirtyImmediate` 一次，无位置变化不写 store、不落库；自动保存不写入中间位置。
6.3 提交只改 `position`；组成员相对位置不变。组归属、组框重算、空组删除仍在 `onNodeDragStop` 执行，顺序与现状一致。
6.4 非拖拽位置帧（`dragging !== true`，会话未激活）按终态位置直接提交、不吸附；吸附只作用于指针拖动。本仓库键盘微移走 `nudgeSelectedNodes` 直接写 store（不经过位置帧路径），此处修复的是「吸附开启时非拖拽位置帧被回退」的既有缺陷，并为将来任何 `updateNodePositions(dragging=false)` 调用方兜底（2026-10-29 已确认纳入）。
6.5 增删节点/边、修改节点数据等结构调整不受影响。

### 7. 拖动期外部写入

7.1 拖动期 store 的 `nodes` 被外部写入替换（撤销/重做、生成任务回填、远端同步、拖动中新挂载等任何非会话提交的替换）时，会话以新数组为基准重建快照：同步清除旧预览偏移，下一次预览帧按新基准计算；拖动不中断。实现上渲染层采用新 `nodes` 即视为外部写入（会话自身提交由 7.3 区分），不按来源枚举。
7.2 受影响节点被删除时移出会话；拖动项全部消失时不再提交任何位置。
7.3 会话自身提交引起的 `nodes` 替换不视为外部写入。

### 8. 一致性

8.1 松手结果（吸附落点、组成员、组框、空组删除、自动保存、撤销）与改造前一致。
8.2 拖动期间缩放/平移（含 autoPan）不改变预览语义：节点与边按画布坐标位移，屏幕空间叠层按当前 zoom 换算。
8.3 不改变框选、连线、多选、点击、双击等交互。

## 技术影响

新增（均属 `web/src/features/canvas` 领域层，无新依赖）：

- `drag/drag-preview-session.ts`：会话控制器（begin/preview/commit/cancel/release、rAF 合并、DOM 应用、外部写入重建、释放时序）。非 React 模块，由 `InfiniteCanvas` 持有并传入 store / React Flow 访问器。
- `drag/drag-snap.ts`：从 `handleNodesChange` 抽出的纯吸附/对齐计算，供预览与提交共用。
- `drag/preview-guides.ts`：辅助线瞬态订阅，`AlignmentGuides` 消费。
- `shared/edge-geometry.ts`：`computeEdgePath`（inset 锚点 + `getBezierPath`），`DeletableEdge` 与会话共用。
- `drag/edge-geometry-registry.ts`：`DeletableEdge` 登记拖动前端点几何，卸载注销。
- `drag/pointer-position.ts`：鼠标/触屏指针坐标读取，拖动参考点补偿的按下点与阈值事件点两端共用同一口径。
- `shared/node-positions.ts`：位置帧 ↔ 按 id 位置表的转换与节点位置写入，会话终态提交与程序化位置帧直接写入共用同一实现。
- `drag/position-routing.ts`：位置帧分流（过程帧 → 会话预览；终态帧 → 会话提交；无会话 → 直接写入），是过程帧永不落库、直接写入是 `markDirty` 唯一触发路径的证明点。

修改：

- `InfiniteCanvas.tsx`：`handleNodesChange` 按「拖拽帧 → 会话 / 终态帧 → 提交 / 其他变更 → 现状」分流；拖动开始/停止接线；容器捕获阶段记录按下点供参考点补偿；移除 `alignmentGuides` 局部状态；卸载时 `cancel()`（项目切换经会话门在渲染期重置为 `connecting`，页面换回加载门即卸载画布，同样走 `cancel()`）。
- `controls/DeletableEdge.tsx`：改用共享几何函数并登记几何，视觉不变。
- `controls/AlignmentGuides.tsx`：改为订阅瞬态辅助线，去掉 props。
- 测试：新增会话、吸附、边几何、位置帧分流与清理用例；现有测试保持通过。

约束：

- 会话依赖本仓库固定的 React Flow 12.12 受控模式与 DOM 契约（`.react-flow__node[data-id]`、`.react-flow__edge[data-id]`、`.react-flow__nodesselection`、`.react-flow__node-toolbar[data-id]`、`.react-flow__edgelabel-renderer`）；升级 React Flow 必须重新验证契约。
- 保持现有约束：事件处理器读取 store 实时状态（过期闭包回归测试 `__tests__/features/canvas/stale-event-handler.test.ts`）；不拆分 `InfiniteCanvas` 文件。
- 不修改 store schema、持久化数据与接口契约。

## 异常与边界

| 场景 | 行为 |
| --- | --- |
| 未越过阈值 / 点击未移动 | 无会话、无 store 写入 |
| 拖动中指针取消（pointercancel） | React Flow 结束拖动；按终态帧或 stop 兜底提交 |
| 拖动中节点被删除（abortDrag） | 终态帧仍到达（`@xyflow/system:2317-2325`）；按现存节点提交并结束预览；交互态残留属现状，另行记录 |
| 拖动中撤销/重做、生成回填、远端同步 | 以新 `nodes` 为基准重建会话，拖动不中断（规则 7） |
| 拖动中画布卸载/切换项目 | `cancel()`，丢弃未提交位移，store 不变 |
| 拖动中切换吸附设置 | 按会话开始时设置执行（拖动中该设置不可达） |
| 拖动中缩放 | 屏幕空间叠层按当前 zoom 换算 |
| 边未登记几何 / 端点节点缺失 | 跳过该边预览，提交后自然对齐 |
| 组成员在拖动中被外部移出组或组被删除 | 以重建后的基准与组关系为准（规则 7） |
| 触摸多指中止 | 同 abortDrag |
| React Flow 升级导致 DOM 契约变化 | 契约测试失败，禁止静默降级 |

## 验收标准

1. 单元测试断言：预览帧不调用 `setNodes`；终态帧恰好提交一次；拖动期 `markDirty` 为 0、会话提交有位移时 `markDirtyImmediate` 为 1（无位移不写 store、不落库）；位置帧分流的测试证明过程帧永不经过直接写入口径（触发 `markDirty` 的唯一路径）。组归属变化的拖动另在 `onNodeDragStop` 产生一次结构写入与 `markDirtyImmediate`（规则 6.3），不计入会话提交的落库次数。
2. DOM 测试（jsdom）：预览后 wrapper 的 `style.translate` 正确、组成员同步平移、清理后无残留；同位移边平移、混合位移边 `d` 更新且与 `DeletableEdge` 几何一致；边标签层隐藏并恢复。
3. 吸附：按 `specs/canvas-snap-alignment.md` 验收标准 1–7 覆盖单选、多选、组/成员、隐藏目标、阈值滞回、辅助线、网格与修饰键；预览帧与提交帧落点、辅助线一致。框选外框拖动整组移动与多选拖动一致，走同一吸附链路。
4. 兜底：无终态帧时由 stop 提交最后预览几何；abort 路径由终态帧提交。
5. 外部写入：撤销/回填期间会话重建，无重复位移与残留偏移；拖动中节点被删除时正确退出。
6. 卸载/取消：无残留 `style.translate`、无残留隐藏层、store 未被写入。
7. 检查：`cd web && npx tsc --noEmit`、`npm run lint`、`npx vitest run`（单 worker、串行）通过。
8. 手工走查（用户确认）：单节点、组、组内成员拖入/拖出、多选、框选外框拖动、吸附开/关、编辑面板打开时拖动、缩放后拖动、autoPan、MiniMap 可见、拖入组高亮。

## 待确认事项

1. 边预览策略：已确认（2026-10-29）「同位移平移 + 混合位移重算路径」（与即梦一致，多选/成员拖入拖出不脱节）。
2. 叠层滞后范围：已确认（2026-10-29）接受 MiniMap、rail 宽度、媒体优先级/LOD 在拖动期不更新（提交时更新），编辑面板与选中框按规则 5.1/5.2 跟随。
3. 外部写入策略：已确认（2026-10-29）「以新 store 为基准重建、拖动不中断」（规则 7）。
4. 键盘微移的顺带修复：已确认（2026-10-29）一并纳入（规则 6.4）。
5. 起拖阈值：已确认（2026-10-29）保持 2px 不变；即梦为 4px，静态分析判断阈值不是「跟手」差异主因；如仍觉得起拖迟钝，另行评估（不属本 Spec）。2026-10-29 补充：阈值大小本身仍保持不变，但「参考点在阈值事件才建立」导致的位移丢失已由规则 2.7 补偿；阈值只保留「点击/拖动判定」职责。2026-10-29 用户再次实测后要求把阈值由 2px 降为库默认的 1px（`nodeDragThreshold={1}`，`nodeClickDistance` 仍为 3px）：阈值只保留点击/拖动判定职责，起拖死区随阈值减小；同时按规则 2.8 把会话 `begin` 前移为激活回调的第一件事，起手首帧不再等待历史/命中索引等簿记。

## 与现有 Spec 的关系

- `specs/canvas-undo-redo-integrity.md`：历史压栈与撤销语义不变，本 Spec 只改变拖动期位置进入 store 的时机。
- 媒体加载/缓存类 Spec（`canvas-audio-peaks-cache.md`、`canvas-media-resolution-lod.md` 等）：拖动期派生滞后到提交，不改变其规则。
- `specs/storage-*`、`specs/task-queue-bullmq.md`：不涉及。

## 当前状态

- 需求调查已完成（静态代码与依赖源码证据见上文）；实现已按确认版本完成（见下），状态待验收标准 8 走查通过并经用户确认提交后由用户设为「已实现」。
- 运行时对标结论来自即梦线上 bundle 的静态分析，登录墙内行为未验证。
- 2026-10-29 已逐条对照即梦实现核对：核心机制（不写 store、rAF 合并、终态提交、DOM 预览、边平移/重算、标签层隐藏、屏幕叠层 zoom 换算）一致；混合位移时隐藏选中框已按即梦对齐（规则 5.1）；其余差异见「与即梦实现的差异（有意保留）」。
- 2026-10-29 用户确认：不引入动作层校验，提交点保留为未来插入点（规则 1.8）。
- 2026-10-29 用户确认待确认事项 1、2、4、5 按建议方案；事项 3（外部写入策略）同日按建议确认。全部待确认事项已确认。
- 2026-10-29 用户明确设置「已确认」，按确认版本开始实现；实现完成后依据验收标准核对，通过并提交后更新为「已实现」。
- 2026-10-29 按确认版本实现完成：新增 `web/src/features/canvas/drag/`（`drag-preview-session.ts` 会话、`drag-snap.ts` 吸附纯函数、`preview-guides.ts` 辅助线瞬态订阅、`edge-geometry-registry.ts` 边几何登记）与 `shared/edge-geometry.ts`（连线几何唯一实现）；`InfiniteCanvas.tsx` 位置帧按「拖动帧 → 会话 / 终态帧 → 提交 / 无会话 → 直接提交」分流并持有会话生命周期；`DeletableEdge.tsx` 改用共享几何并登记端点；`AlignmentGuides.tsx` 改为订阅瞬态通道。
- 2026-10-29 验收标准 1–6 由新增 `web/src/__tests__/features/canvas/drag/drag-preview-session.test.ts`（16 例，jsdom）覆盖并通过；验收标准 7：`npx tsc --noEmit` 通过、`npm run lint` 0 error（6 条既有 `<img>` warning）、`npx vitest run` 单 worker 全量 160 文件 / 1269 例通过（终态代码）。
- 2026-10-29 实现期核对修正：规则 6.4 与「现状.4」「与即梦实现的差异」原述「本仓库保留 React Flow a11y 键盘、键盘微移被丢弃」与代码不符，已按已验证事实改写；行为结论（非拖拽位置帧直接提交、不吸附）不变。
- 2026-10-29 用户确认拖动期「一起隐藏」外框批量接驳轨道（与节点左右轨道一致）：规则 5.1 更新为轨道整体隐藏、显隐改由容器 `data-interaction` 的 CSS 规则统一开关；拖动会话移除轨道平移/隐藏接管（不再查询 `.batch-connect-handle`），测试断言改为「会话不写轨道 DOM」，用例数不变（16 例）。
- 2026-10-29 用户报告「快速移动、尤其低缩放时节点跟随慢于指针（鼠标已移出节点），与节点数量无关」。运行时复现与源码核对确认根因为规则 2.7 所述参考点丢失：在预览页对单个节点做 rAF 分隔的合成拖动，指针依次移动 +40 / +100 / +160 屏幕 px，节点屏显位移依次为 0 / 60 / 120（= 指针位移 − 阈值事件点位移），且 `style.translate` 与屏幕位移严格按 zoom 换算（1:1 跟随，无增益损失）；同时确认拖动期无 store 写入、无逐帧 React 渲染、无 CSS 过渡/滤镜参与。按规则 2.7 实现补偿（会话 `begin` 新增 `preThresholdOffset`，`InfiniteCanvas` 以按下点与 `onNodeDragStart` 事件点之差传入），新增 `drag/pointer-position.ts` 统一鼠标/触屏坐标口径。
- 2026-10-29 补偿复核：运行时实测 `PointerEvent.clientX` 保留小数（100.6）而 `MouseEvent.clientX` 取整（100），用 `pointerdown` 作按下点会与 React Flow 读到的 `mousemove` 坐标差出 ≤1px（合成拖动实测残差 0.94px）。按下点改由容器捕获阶段的 `mousedown`/`touchstart` 记录（与 d3-drag 同源、精度一致），规则 2.7 同步；改后同一合成拖动（指针 +100 / +160 屏幕 px）节点屏显位移精确为 100 / 160 px（`style.translate` 94.7323 / 151.572 画布 px × zoom 1.05561），亚像素残差消失。
- 2026-10-29 复核结果：`npx tsc --noEmit` 通过；`npm run lint` 0 error（6 条既有 `<img>` warning）；`npx vitest run src/__tests__/features/canvas/drag`（单 worker）2 文件 21 例通过；全量单 worker 连跑三轮，每轮均有计时敏感用例在满载下抖动（`useSseTaskMonitor`、`useFileAccessUrl`、`HoverCard`/`ResolvedHoverMedia`），三轮失败集合互不相同，这些文件单独运行全部通过（8/8、11/11、12/12、22/22），且均不导入本次改动的模块。
- 2026-10-29 用户追问「按下再移动仍比即梦慢一拍」。源码核对确认起手存在一次事件的死区：阈值事件上 `startDrag` 把 `lastPos` 设为同一指针位置，紧随的 `updateNodes` 判定被跳过，节点首次位移要等下一次 `mousemove`；合成拖动同样测得阈值事件后节点位移为 0。按规则 2.8 在 `begin` 末尾补出首帧（基准位置经补偿后即为指针落点，同步应用），会话新增两个用例（补首帧即落位、补帧后立即松手按补偿位置提交）。
- 2026-10-29 规则 2.8 复核：`npx tsc --noEmit` 通过；`npm run lint` 0 error（6 条既有 `<img>` warning）；`npx vitest run src/__tests__/features/canvas/drag`（单 worker）2 文件 23 例通过。预览页（zoom 0.2）单节点合成拖动：按下不写 DOM；阈值事件（指针 +40 屏幕 px）同步产生 `translate: 200px` 且节点屏显位移精确 +40px（此前该事件位移为 0）；随后指针 +100 / +160 屏幕 px 时屏显位移同为 +100 / +160px，控制台无错误；未松手即重载页面，节点位置不变，确认拖动期无 store 写入。
- 2026-10-29 起拖相位实测（即梦对照，同一探针口径）：两端的指针采样到 DOM 写入链路同量级（写入时最新采样年龄 p50 3.6 / 6.8ms，即梦 4.9 / 8.2ms；即梦用层位移、无 React 写入），剩余差异集中在起步：即梦按下→首次写入 40–75ms，本仓库 57.1ms 且首帧滞后 30.5ms。用户要求先补起步相位：会话 `begin` 前移为 `onNodeDragStart` 的第一件事（历史/命中索引/交互状态后置），并按用户决定把 `nodeDragThreshold` 由 2 降为 1（规则待确认事项 5、非目标同步更新）。首帧写入本身（规则 2.8）此前已实现，本次只调整其在回调中的位置与阈值。
- 2026-10-29 起步相位复核（真实鼠标，缩放 0.132；控制台累计 8 次真实拖动）：稳态帧间隔 p50 16.7 / p90 16.8–16.9ms，多数拖动零长帧；写入滞后 p50 2.6–4.2 / p90 5.9–8.4ms、匹配率 1、全程仅 1 次 React 写入，写入时最新采样年龄 3.5 / 6.6ms（即梦 4.9 / 8.2ms），稳态已优于即梦。起步阶段（临时性能标记实测）：事件排队 1.6–6.4ms、会话建立（含首帧写入）0–0.2ms、簿记 0–0.1ms，首帧在跨阈值后约 2–6ms 写入 DOM；按下→首帧 43.1 / 63.6ms、首帧滞后 38.3 / 16.6ms（即梦 40 / 24.5ms）——首帧滞后随同任务负载在 12–38ms 间波动（最大的 38.3ms 对应一次 33.4ms 长帧，回调返回后的同步工作占约 32ms），其余 7 次为 12–33ms。临时诊断（`?diag=drag` 覆盖层与阶段性能标记、即梦探针脚本）取数后已全部删除，不进入版本控制。
- 2026-10-29 未提交代码两轴审查后的根因修复：位置写入抽取为 `shared/node-positions.ts`（`applyNodePositions`，会话提交与直接写入共用，去掉两处重复的按 id 写位置实现）；位置帧分流抽取为 `drag/position-routing.ts`，新增 `position-routing.test.ts`（5 例）证明过程帧永不经过触发 `markDirty` 的直接写入口径，补上验收 1 此前只由未测接线保障的空缺；会话终态提交在没有位置变化时不再调用 `markDirtyImmediate`（规则 6.2 同步，去掉一次空保存）；会话 `handleRenderedNodes` 更名 `syncRenderedNodes`（外部写入重建拆为私有 `rebuildFromStore`）；`Delta` 私有类型更名 `Point`（位置与位移共用）；「位置帧每帧重渲染」类注释按现状改写为「拖动期位置帧只写 DOM、程序化位置帧（整理动画等）逐帧替换 nodes」。
- 2026-10-29 第二轮未提交代码两轴审查后的根因修复（对外行为不变）：
  - 位置帧 ↔ Map 的转换集中到 `shared/node-positions.ts` 的 `toPositionMap` / `toPositionFrames`，会话预览/提交/兜底/重建与画布直接写入共 5 处不再各写一份；
  - `shared/node-positions.ts` 的口径由「画布唯一位置应用口径」收窄为「位置帧应用口径」：整理动画、键盘微移、组框重算等结构/几何写入不属于位置帧，避免虚假的「唯一」宣称；
  - `shared/node-identity.ts` 恢复 HEAD 的模块级复用缓冲：上一轮把 `assertUniqueNodeIds` 改成每次分配 `Set` 属与本 Spec 无关的重构，按 AGENTS.md 六.1 回退，语义与分配口径回到 HEAD；
  - 规则 1.7 复核（已验证）：项目切换时 `use-canvas-session` 在渲染期把状态重置为 `connecting`（`web/src/features/project/use-canvas-session.ts:149-153`），页面加载门换掉画布 → `InfiniteCanvas` 卸载 → `dispose()` → `cancel()`；画布根节点是组件的无条件根元素，移除即卸载。两条路径均覆盖，不新增监听；
  - 吸附盒尺寸（`drag/drag-snap.ts` 的 `nodeBoxSize`，显式尺寸优先）与布局估算（`shared/tidy-layout.ts` 的 `measureNode`，实测尺寸优先）保持各自口径：HEAD 吸附即显式尺寸优先，规则 3.1 要求「与现状一致」，不合并两者；`use-tidy-animation.ts` 不在本 Spec 影响面内，未改动；
  - 复核：`npx tsc --noEmit` 通过；`npm run lint` 0 error（6 条既有 `<img>` warning）；`npx vitest run src/__tests__/features/canvas/drag`（单 worker）28 例通过（`drag-preview-session` 20、`position-routing` 5、`pointer-position` 3）；`src/__tests__/features/canvas` 71 文件 / 666 例通过；全量单 worker 162 文件 / 1281 例通过。上文「16 例」为当轮记录。
  - 未提交树还包含与本 Spec 无关的并行改动（画布外壳 memo 提取 `controls/ProjectToolbar.tsx`、生成面板上游引用 `shared/upstream-refs.ts` 及其 hook/测试）：本轮审查未把它们当作本 Spec 的需求，也未改动其行为。
- 2026-10-29 验收标准 8 逐项走查（预览环境、合成指针事件、scratch 项目 `mvter0ogv2bill`；证据为运行时 DOM 采样与 PUT 计数）：
  - 单节点：拖动期只有 wrapper `style.translate` 变化、store `transform` 保持基准（`interaction=dragging-nodes`），松手恰好 1 次 PUT；撤销精确还原。
  - 组：组与成员 wrapper 同帧同值平移，成员自身 `transform` 不变（相对坐标）；提交 1 次 PUT，持久化 payload 中成员 `parentId=组`、位置为组内相对坐标。
  - 成员拖入：拖入过程逐步采样，进入组区域后目标组出现 `.node-drag-over`（`highlightIds=[g-…]`），松手后归属生效（payload `parentId=组`），1 次 PUT。
  - 成员拖出：组内拖动与拖出时目标组不高亮（归属未变化），组 `transform` 不变；拖出后 payload `parentId=null`、绝对坐标，1 次 PUT；拖出最后一个成员后空组自动删除（payload 仅剩两个顶层节点），1 次 PUT。
  - 多选与框选外框拖动：选中集合与外框同步平移，拖动期 store 位置不变，落点提交。
  - 吸附开/关：开启时预览与落点均为吸附值（组拖动 450/275 屏幕位移落成 +440.16/+274.682）；关闭后允许小数落点（-7599.4367/1540.3755）。
  - 编辑面板打开时拖动（多角度面板）：拖动期节点 `translate=300px 200px`（画布单位）、面板 `translate=60px 40px`（画布位移 × zoom 0.2，规则 5.2）；松手 1 次 PUT，撤销还原。标注面板的 `nodrag` 画布覆盖层会接管节点主体上的拖动（现有设计，非回归）。
  - 缩放后拖动：zoom 0.497664 下指针 +60/+40 屏幕 px → 预览 `120.563/80.3755` 画布 px（= 屏幕位移 / zoom），提交 `(-7599.4367, 1540.3755)`，1 次 PUT，撤销还原。
  - autoPan：按住右边缘拖动时视口持续平移（4134.28→3815.53），预览 translate 2191.24→2959.83 画布 px 且节点保持贴边；松手落点与指针屏幕位置一致（节点中心 1544 vs 指针 1543），提交 1 次 PUT。拖动期唯一额外 PUT 来自视口持久化（`syncLiveViewport` → `markDirty`，请求体为 store 中未变的旧位置），不是位置写入。
  - MiniMap：开启后显示 180×120 小地图与 2 个 minimap-node；拖动期小地图坐标保持拖动前值（规则 5.4 接受的滞后），提交后更新，1 次提交 PUT，撤销还原；走查后恢复关闭（`minimapVisible:false`）。
  - 走查后 scratch 项目恢复为 2 个顶层节点、无组、吸附关闭、小地图关闭；节点位置经合成拖动还原到走查前坐标 ±0.85px（video -8160.56/901.948 vs -8160.16/902.797；image -6475.35/865.909 vs -6474.56/865.318），视口停在 fitView（zoom 0.617011，两节点完整可见）。
  - 复验：重载到干净构建后重新拖动，控制台无错误；此前控制台的 `markDragStartPhase is not defined` 来自诊断代码删除前编译的旧页面实例，当前源码与 dev 构建产物均不含该标识符（已验证）。
- 2026-10-29 上述走查由 Agent 在预览环境完成（合成指针事件）；验收标准 8 的真人操作与「跟手」主观体验仍需用户确认。
- 2026-10-30 用户确认验收标准 8 走查通过；实现与编译依赖同批提交（`6d14d5eb` feat(canvas): 拖动改为 DOM 预览会话并在终态一次提交），状态更新为「已实现」。提交树已在独立工作树复核：`tsc --noEmit` 通过，`src/__tests__/features/canvas` 69 文件 / 661 例通过。
- 2026-10-30 吸附规则由 `specs/canvas-snap-alignment.md` 取代（对齐常开、网格独立、多选/组并集吸附、屏幕像素阈值与滞回、修饰键）。本 Spec 规则 1.6、3.1、验收标准 3 已同步；拖动预览、边路径、释放时机与外部写入重建机制不变。

## 调查记录

- 项目代码：`InfiniteCanvas.tsx`（拖动链路、吸附、历史）、`DeletableEdge.tsx`、`AlignmentGuides.tsx`、`BatchConnectHandle.tsx`、`NodeToolbar.tsx`、`editing/*`、`use-canvas-interaction.ts`、`use-alignment-guides.ts`（2026-10-30 已删除，几何规则并入 `shared/snap-engine.ts`，类型与按值比较并入 `shared/alignment-guides.ts`）、`canvas-store.ts`、`canvas-derived.ts`、`group-membership.ts`、`node-identity.ts`、`use-canvas-keyboard.ts`、`use-tidy-animation.ts`、`ResizeHandle.tsx`。
- 依赖源码：`@xyflow/react` 12.12（`setNodes` / `triggerNodeChanges` / `NodeWrapper` / `NodesSelection` / `NodeToolbar` / `BaseEdge`）、`@xyflow/system`（`XYDrag`、`getDragItems`、`getEventHandlerParams`、`updateChildNode`、`getNodeToolbarTransform`）。
- 对标：即梦 `ai-canvas` 生产 bundle 静态分析（`65cefeba57f29641.js` 等），仅作方向参照，未在运行时验证。
- 跟手问题（2026-10-29）：`@xyflow/system` 的 `getDragItems`（2050-2065，`distance = 参考点 − 节点位置`）、d3-drag `start`/`drag` 阈值分支（2271-2320，越过阈值才调用 `startDrag`，且该事件不触发 `updateNodes`）；运行时合成拖动（rAF 分隔）测得节点位移 = 指针位移 − 阈值事件点位移。排除项（代码与运行时均已核对）：每帧 store 写入、逐帧 React 渲染、吸附/对齐逐帧开销（`snapToGrid` 关闭时 O(1)）、节点 wrapper 的 CSS 过渡与滤镜、rAF 合并（输入在帧内先于 rAF 派发，合并不增加显示延迟）。

# 画布框选手势会话（Marquee Gesture Session）

状态：已确认（2026-10-30）

承接 `specs/canvas-drag-preview-session.md`：该 Spec 已把节点拖动改为「拖动期只做 DOM 预览、松手一次提交」，并在业界对标中认定「即梦的框选手势是独立会话」，但明确把框选排除在拖动会话之外。本 Spec 处理这块剩余项。

## 目标

把框选从「React Flow 内建框选：每次指针移动同步写受控 store」改为独立手势会话：

- 手势期间按 rAF 合并指针帧，命中结果只写 DOM 预览，不写受控 store；`nodes` / `edges` 引用保持不变；
- 命中测试基于激活时冻结的几何索引，不随帧做 O(N) 全量扫描；
- 松手时一次提交节点与边选中，边的选中写入不进入撤销历史；
- 交互语义与现有画布保持一致（左键拖空白框选、点击空白清空、中键/空格平移、触摸不平移语义不变），并按即梦规则统一组与追加选择语义；
- 保留边缘自动平移、点击抑制、提交后交互状态等现有行为。

## 现状与已验证事实

> 行号为调查时（改动前 HEAD `8a3fa784`）的位置；实现后行号已变化。

### 1. React Flow 内建框选链路（12.12）

- `selectionOnDrag={true}`（`web/src/features/canvas/InfiniteCanvas.tsx:1150`）、`selectionMode={SelectionMode.Partial}`（`:1132`）、`onSelectionStart`（`:1130`）。
- Pane 在 `pointerdown` 捕获阶段建立选择：仅当目标是 pane 容器本身、左键、`isPrimary`、且 `selectionOnDrag` 或 `selectionKeyPressed` 成立；随后 `setPointerCapture`（`node_modules/@xyflow/react/dist/esm/index.mjs:1478-1513`）。
- **每次指针移动同步执行一次提交**：`onPointerMove` 直接调用 `commitUserSelectionRect`（`:1588-1611`），不是按 rAF 合并。
- 提交内容（`:1515-1564`）：`getNodesInside`（O(N)，`@xyflow/system:320-347`，Partial 为重叠面积 > 0）→ 对每个选中节点经 `connectionLookup` 取相连边（**任一端点选中即选中该边**，`:1538-1550`）→ 选择集变化时 `triggerNodeChanges` / `triggerEdgeChanges`。
- 每次提交把 `userSelectionActive` 置 true、`nodesSelectionActive` 置 false（`:1558-1563`）；`pointerup` 时再按最终节点数恢复 `nodesSelectionActive`（`:1612-1641`）。聚合选中框 `NodesSelection` 只在 `nodesSelectionActive` 为 true 时渲染（`:2124`），并由 `adoptUserNodes` 在无选中节点时自动关闭（`:3445`）。
- 激活阈值：`distance <= (selectionKeyPressed ? 0 : paneClickDistance)` 时不动；`paneClickDistance` 默认 1，Shift 按下时为 0（`:1596-1604`）。
- 首次越过阈值时 `resetSelectedElements()` 清空选中并回调 `onSelectionStart`（`:1601-1604`）。
- 边缘自动平移：`calcAutoPan`（40px 边缘带、默认速度 15）+ 每帧 `panBy`，平移后重新提交（`:1565-1579`、`@xyflow/system:calcAutoPan`）。
- 松手后的 click 由 `selectionInProgress` 拦截，不触发 `onPaneClick`（`:1450-1461`、`:1470-1475`）。
- `selectionKeyCode` 默认 `'Shift'`：即使关闭 `selectionOnDrag`，按住 Shift 左键拖仍会启用内建框选。

### 2. 本仓库每帧成本链（结构分析，未做运行时采样）

- `commitUserSelectionRect` → `triggerNodeChanges` → `handleNodesChange`（`InfiniteCanvas.tsx:480-504`）→ `setNodes`（全量数组）→ `InfiniteCanvas` 重渲染 + `getCanvasDerived` 重算（`selectionFrame`、全边扫描的 `highlightedEdges`、rail 宽度）+ React Flow 受控同步的 `adoptUserNodes`（O(N) lookup 拷贝）+ 经 `renderedNodes` 订阅的第二轮渲染。
- 选中变化的节点经 `memoCanvasNode` 重渲染；低缩放下大范围扫过时，每帧变化的节点数可达数百。
- 边：`triggerEdgeChanges` → `handleEdgesChange`（`:506-511`）→ `setEdges` 无选项（`canvas-store.ts:401-404`）→ `maybePushHistory`（`:69-83`，300ms 节流）→ 生成历史快照。**框选的边选中因此会污染撤销栈**。
- 命中测试本身是 O(N)，边选择是对选中节点相连边的 union；它们不是最大头，但在低缩放 / 大节点数下与 React 提交叠加。

结论：不跟手的主因是「每次指针移动都写受控 store 并触发两轮 React 提交」，与拖动 Spec 的结论同源；RF 的指针捕获并非缺失项。

### 3. 现有选择语义

- Partial：节点矩形与框选矩形**有重叠**即选中。
- 组：组节点是可选中节点，其矩形包住成员。框选碰到任一成员时，组矩形也必然重叠 → **组与成员同时被选中**；与「点击成员只选成员、点击组只选组」（`handleNodeClick`，`:923-943`）不一致。
- Shift 不是「追加框选」：它只是启用内建框选的键；每次提交仍以矩形结果替换选中集。
- 边：任一端点被选中的边全部选中；边选中后的 Delete 行为依赖该状态。
- 框选开始即清空原选中（RF `resetSelectedElements`），取消（Esc/失焦）没有恢复语义。

### 4. 可复用件

- 绝对几何：`buildNodeIndex` / `nodeAbsolutePosition`（`web/src/features/canvas/shared/group-bounds.ts:32-51`）、`measureNode`（实测优先，`shared/tidy-layout.ts:86-91`）、组判定与成员关系（`shared/group-membership.ts`）。
- 会话模式：`DragPreviewSession`（`drag/drag-preview-session.ts`）的 rAF 合并、DOM 契约、`syncRenderedNodes` 采用后释放、`cancel/dispose` 生命周期；`InfiniteCanvas.tsx:188-208` 的实例创建与布局副作用接线。
- 交互状态机：`selection-start` / `click`（`stores/canvas-store.ts:323-349`），`showSelectionChrome` 仅在 idle 为真。
- 主题与选中视觉：`.node-body.node-selected` 使用 `--ring` 主题 token（`web/src/styles/globals.css:252-261`）；框选矩形沿用 `.react-flow__selection` 的 `--marquee-bg` / `--marquee-border`（`:230-237`）。

## 业界对标（即梦画布，静态分析）

对线上 bundle 的静态阅读（登录墙限制，**运行时未验证**）：

- RF 内建框选关闭（`selectionOnDrag: false`）。独立指针会话类持有 pointer capture、`pointerup` / `pointercancel` / window blur、激活阈值、rAF 帧循环；超过阈值才进入选择态。
- 激活时对当前节点集合建立**冻结的空间哈希索引**（uniform grid；大节点单独列表；查询覆盖 cell 数超过 4096 时退化为全量线性扫描），手势期间几何不重建。
- 命中规则：普通节点与矩形**相交**即命中；**只有完全包含的组才命中**，且其成员被排除；部分相交的组不命中，但其相交成员可单独命中。最终集合再去掉「已选中组的子节点」。
- 追加：`pointerdown` 时读取 Shift/Meta/Ctrl，按住则以当前已提交选中集为 baseline，否则以空集为 baseline；手势中途按键不改变本次模式。
- 预览：选择态只做轻量呈现（即梦为 canvas 画层），拖动期隐藏聚合选中框；预览失败才退回 DOM 选框。手势期间不写已提交选择。
- 松手时只提交一次（`canvas.selection.commit`），提交后设置 `suppressClick` 吞掉后续 click；边不参与手势预览与提交。

## 与即梦实现的差异（有意保留）

1. **预览介质**：即梦用 canvas 画层；本仓库用「React Flow 节点包装元素上的 `data-marquee-hit` 属性 + CSS」绘制高亮，选框复用现有 `.react-flow__selection` DOM。理由：
   - 选中视觉由 CSS 主题 token（`--ring`、阴影、圆角）定义，canvas 需要重复实现颜色与阴影，并满足 `web/AGENTS.md` 九.2「Canvas 颜色随主题切换更新」的额外契约；
   - 高亮由 CSS 变换自动跟随视口，每帧只需写选框一个元素与命中集合的差量属性，无需逐节点投影绘制；
   - 预览高亮与最终选中态共用同一声明，视觉完全一致。
2. **边选中**：即梦只提交节点集合；本仓库保留「任一端点选中即选中该边」的现有语义（已确认保留）。边在提交时一次性写入并跳过历史。
3. **清空时机**：即梦区分「已提交选择」与「预览选择」；本仓库在激活时按 RF 现有行为清空 store 选中（关闭依赖选中的面板/工具条），并用快照支持取消恢复。
4. **阈值**：即梦约 4px；本仓库已确认保持 1px（Shift 时同样为 1px，不再为 0）。
5. **自动平移**：保留 RF 的 40px 边缘带、速度 15 与逐帧重算。

## 范围

- 新增框选手势会话（指针生命周期、阈值、rAF 帧、取消）。
- 新增冻结几何索引与命中查询（含组闭合规则）。
- 关闭 React Flow 内建框选，接管空白区左键拖拽。
- 预览：选框 DOM + 节点高亮属性 + CSS。
- 提交：节点/边选中单次写入、`skipHistory`、`nodesSelectionActive`、采用后释放。
- 取消路径：Esc / 失焦 / pointercancel / 第二指针 / 项目切换。
- 点击抑制、边缘自动平移、视口变化下的坐标换算。
- 单测（索引与命中、会话生命周期）与既有测试更新。

## 非目标

- 节点拖动、吸附、对齐辅助线（`specs/canvas-drag-preview-session.md`、`specs/canvas-snap-alignment.md`）。
- 点击多选、键盘选择、删除、分组/解组语义。
- 组的归属、尺寸、聚合外框 padding 规则。
- 只渲染可见节点（`onlyRenderVisibleElements`）与 LOD（另有 Spec）。
- 框选视觉重设计（沿用现有虚线/实线、颜色与圆角）。
- 触摸框选（触摸保持现有平移语义）。

## 业务规则

### 1. 启动与阈值

1. 仅当 `pointerdown` 的目标是 `.react-flow__pane` 本身、`button === 0`、`isPrimary`、`pointerType` 为 `mouse` / `pen`、`elementsSelectable` 为真、无进行中的连线、Space 未按下时进入候选。节点、边、Handle、面板、`.nokey` 区域不进入。
2. 候选阶段记录：按下点 flow 坐标、按下点屏幕坐标、修饰键（Shift/Meta/Ctrl）状态、当前选中节点/边 id 快照、`nodesSelectionActive` 快照、内容所有者（`getCanvasProjectId()`）。
3. 激活阈值为按下点到当前指针的欧氏距离，常量 `MARQUEE_ACTIVATION_DISTANCE`，默认 1px（已确认）。未越过阈值不产生任何 store 写入与预览；`pointerup` 后由既有 click 路径清空选区。
4. 触摸不启动框选；中键/右键、Space+左键平移、连线进行中均不启动。
5. 聚合选中外框（`.react-flow__nodesselection`）保持 React Flow 默认命中：其 `-rect` 覆盖选区包围盒（含 40px 外扩），按下落在 `-rect` 上由 React Flow 的 `useDrag` 启动整组拖动（`onNodeDragStart` 携带全部已选节点，进入拖动会话，历史与吸附照常），框内按下不会启动框选；框选只从包围盒外的空白起手。框内节点的按下同样由外框接管，点击不改变选区。2026-10-30 曾把外框改为 `pointer-events: none`（让框内空白起框选），被用户否定并回退——框选后从框内空白拖动必须移动整组。实测：框内空白 `elementFromPoint` 命中 `.react-flow__nodesselection-rect`（`cursor: grab`），`mousedown` + 拖动后 `data-interaction=dragging-nodes`，三个已选节点同步位移、外框随组平移，松手提交并保留选区。

### 2. 会话生命周期

1. 状态：`candidate → active → commit | cancel → released`。同一时刻只有一个会话；新候选出现时先完成上一次释放。
2. 指针事件：候选开始时在 window 上安装 `pointermove` / `pointerup` / `pointercancel`；`pointermove` 只记录最新指针位置并按 rAF 合并，`pointerup` 提交。Esc、Space、window `blur`、`contextmenu` 由 `attach` 时安装的 window 监听处理（键盘监听在捕获阶段）；第二个 `pointerdown`、项目切换/卸载取消。
3. 会话是唯一写预览与提交选中的入口；除「激活清空」「提交」「取消恢复」外，不写受控 store。
4. `dispose`（组件卸载/项目切换）只清理预览与监听，不恢复选区。

### 3. 激活

1. 越过阈值时：以最新 store 节点构建冻结索引；缓存画布根、pane、选框元素与 `id → wrapper` DOM 索引。
2. 清空 store 选中：`setNodes`（仅当有选中节点）+ `setEdges(..., { skipHistory: true })`（仅当有选中边）；RF `nodesSelectionActive` 置 false。等价于 RF 现有的 `resetSelectedElements`，但边的清空不进入历史。
3. 派发 `selection-start`（交互状态进入 `box-selecting`）。
4. 设置指针捕获、安装 click 抑制器（见规则 10）、显示选框。
5. baseline = 追加模式下为按下时的选中节点 id 集，否则为空集。

### 4. 冻结几何与命中

1. 索引条目：`{ id, 绝对矩形（nodeAbsolutePosition + measureNode）, 是否组, 父组 id }`；跳过 `hidden === true` 与 `selectable === false` 的节点。
2. 空间哈希：单元格边长 256 flow 单位；矩形覆盖超过 64 个单元的节点进入「大节点」列表，每次查询都检查；查询覆盖单元数超过 4096 时退化为对全部条目的线性扫描（与即梦一致）。
3. 命中规则：
   - 组：矩形**完全包含**于框选矩形才命中（`x >=`、`y >=`、`x+w <=`、`y+h <=`）。
   - 非组节点：与框选矩形**相交**（重叠面积 > 0）即命中。
   - 非组节点若其父组在命中组集合中，则排除。
4. 最终集合 = baseline ∪ 命中集合，再排除「已选中组的子节点」（baseline 中的组同样生效），最后按 id 去重。
5. 手势期间不重建索引；外部写入（生成回填等）不改变本次命中结果；提交时按当前 store 过滤已不存在的 id。

### 5. 组语义（已确认）

采用即梦语义：完全包含才选中组并排除成员；部分相交的组不选中，但其成员可按普通节点命中。由此框选与点击一致：点击成员只选成员，框选部分覆盖组时也只选成员。与现状（部分重叠即同时选中组和成员）不同。

### 6. 追加选择（已确认）

`pointerdown` 时按住 Shift/Ctrl/Meta 之一 → 本次为追加（baseline 为当前选中）；否则为替换。修饰键只在按下时读取一次，手势中途不改变模式。

### 7. 预览

1. 每帧：由当前视口变换把起点 flow 坐标与当前指针投影为屏幕坐标，得到框选矩形（屏幕空间）；同时用 flow 矩形查询冻结索引得到 presented 集合。
2. 选框：固定在 `<ReactFlow>` 内的单个元素（`data-canvas-marquee`，类名沿用 `react-flow__selection react-flow__container`，React 侧只渲染静态结构），会话直接切换 `data-active` 并写 `width` / `height` / `transform`；视觉沿用现有虚线、圆角与 `--marquee-bg` / `--marquee-border`，z-index 6。
3. 节点高亮：对 presented 中新增的节点在 `.react-flow__node[data-id]` 包装元素上写 `data-marquee-hit`，移除离开集合的属性；该属性不由 React 管理，包装元素重渲染不会清除，故只需差量写入。
4. `data-marquee-hit` 的高亮声明与 `.node-body.node-selected` 共用（`--ring` 1px 描边 + 现有阴影），并给包装元素 `z-index: 1000`（与 RF 选中节点抬升常量一致），使预览与最终选中视觉一致；组节点除外——组节点按既有规则始终沉底（`z-index: -1`，避免组矩形盖住组内连线与成员），预览同样不抬升，与提交后的选中态一致。
5. 手势期间不预览边（提交时一次性生效）；MiniMap 与依赖 store 选中的界面在手势期间保持清空状态，提交后更新。
6. 每帧只写选框样式与属性差量；presented 集合不变且视口未平移时跳过写入。

### 8. 提交

1. `pointerup` 时若会话处于 active：以最后一帧（若无帧则用当前指针）计算最终节点集合，过滤当前 store 中存在的 id。
2. 边集合：当前 edges 中 `selectable !== false` 且任一端点属于最终节点集合的边。
3. 一次性写入：`setNodes`（仅当选中标记有变化）与 `setEdges(..., { skipHistory: true })`（仅当有变化）；随后置 RF `nodesSelectionActive = 节点集合非空`。
4. 交互状态保持 `box-selecting`（与现状一致）；不派发 `click`。
5. 预览只覆盖节点高亮：节点选中发生变化时保持到渲染层采用新的选中状态（复用 `renderedNodes` 布局副作用上的 `syncRenderedNodes`，与拖动会话同路径），随后移除全部 `data-marquee-hit`、隐藏选框、释放索引与监听；仅有边变化或没有变化时立即释放（边选中不影响节点渲染）。
6. click 抑制器是一次性的，但**不在提交释放预览时移除**：提交是对 `pointerup` 的离散事件处理，React 可能在同一事件内同步完成渲染，`syncRenderedNodes` 释放预览会先于浏览器派发的尾随 `click`；此时移除会让该 click 漏进 `onPaneClick`。抑制器改由两处解除：吞掉一次 click（无论目标是否为 pane）后，或画布容器上下一次 idle `pointerdown` 时。见规则 10。
7. 不改变持久化语义：选中状态仍按现有 store 行为处理，不额外 `markDirty`。

### 9. 取消

1. 触发：Esc（window keydown 捕获阶段，候选与激活阶段均生效）、window `blur`、`contextmenu`（右键菜单接管时结束手势）、`pointercancel`、丢失指针捕获、第二个指针按下、项目切换/卸载。候选阶段取消只结束指针会话，不恢复、不派发交互状态（此时尚未写任何状态）。
2. 恢复按下时的节点/边选中与 `nodesSelectionActive`（`setEdges` 带 `skipHistory`），再清理预览；交互状态派发 `click` 回到 idle。
3. 内容所有者已变化（`getCanvasProjectId()` 与快照不同）时不恢复，避免把旧项目选区写入新项目。
4. Esc 取消后，既有全局 Escape 处理仍会清空选区（现状语义不变；若编辑面板打开并拦截 Escape，则只取消手势、保留原选区）。
5. 取消不提交、不写历史。

### 10. 点击抑制

1. 激活时在 window 上安装 capture 阶段的一次性 click 监听：React Flow 的 `onPaneClick` 由 React 根委托派发到文档，容器级监听过晚，必须挂在 window 捕获阶段才能先于它。`event.target` 为 pane 时 `preventDefault` + `stopPropagation`，阻止 `onPaneClick`（关闭菜单、blur、清空选区）与 `resetSelectedElements`；其他目标不拦截。无论是否拦截，该次 click 后都解除抑制。
2. 未越过阈值的按下不安装抑制器，click 正常清空选区。
3. 抑制器的生命周期不受提交释放预览影响（规则 8.6）：浏览器未派发尾随 click（如指针在窗口外抬起）时，由画布容器上下一次 idle `pointerdown` 解除；卸载时一并解除。

### 11. 边缘自动平移与视口变化

1. 每帧用当前指针在容器内的位置计算 `calcAutoPan` 等价逻辑（40px 边缘带、速度 15），有位移时调用 RF `panBy`；平移后下一帧重算投影与命中。
2. 起点锚定在 flow 坐标：手势中可以滚轮缩放或平移（自动平移），选框起点随视口变换移动，与 RF 现状一致。
3. 容器矩形每帧读取，窗口尺寸/面板变化不影响坐标换算。

### 12. 交互状态与点击语义

1. 激活派发 `selection-start`；提交保持 `box-selecting`；取消派发 `click`。
2. 点击节点/空白的选择语义不变；框选后工具栏/生成面板只在提交并回到点击态后按现有规则显示。
3. 更新 `canvas-store.ts:316` 中「框选（Shift 拖拽）」的过时注释。

### 13. 历史与持久化

1. 框选引起的节点选中变化不压历史（现状 `setNodes` 本就不压栈）。
2. 框选引起的边选中变化一律 `skipHistory`，修复现有「框选污染撤销栈」缺陷；撤销不会把选中态变化当作可撤销操作。
3. 选中态是否随画布保存沿用现有行为，本 Spec 不改。

### 14. 手势光标

1. 手势进行中光标由手势状态整体接管，不交给 hover 命中决定：框选进行中整块画布为 `default`（普通箭头，2026-10-30 走查确认不要十字光标）；连线进行中为 `crosshair`；节点拖动中为 `grabbing`（pane、节点、节点内控件与聚合外框一致）。指针扫过节点、节点内按钮/文本区与空白时不得在「节点抓手 / 控件指针 / 空白箭头」之间跳变。
2. 框选的判定取选框自身的 `data-active`（仅手势进行中置位）；不能用 `data-interaction="box-selecting"`——该状态表示「最近一次选中来自框选」，会保留到下一次点击。
3. 手势结束后光标回到 hover 派生值（节点 `grab` / 空白 `default`），与现状一致。

## 技术影响

### 新增

- `web/src/features/canvas/marquee/marquee-geometry.ts`：冻结索引（构建 / 查询；预览释放时丢弃引用），纯逻辑，无 DOM。
- `web/src/features/canvas/marquee/marquee-session.ts`：手势会话（指针、rAF、预览、提交、取消）。
- `web/src/features/canvas/shared/geometry.ts`：画布通用几何类型（`Point` / `Rect`）、世界坐标浮点容差与 `samePoint`。
- `web/src/__tests__/features/canvas/marquee/marquee-geometry.test.ts`
- `web/src/__tests__/features/canvas/marquee/marquee-session.test.ts`
- `web/src/__tests__/features/canvas/marquee/fixtures.ts`：节点与带尺寸矩形工厂。
- `web/src/__tests__/test-utils/raf.ts`：可手动推进的 rAF 桩。

### 修改

- `web/src/features/canvas/InfiniteCanvas.tsx`
  - 创建并持有会话（与 `dragSession` 同模式，依赖稳定引用）；在依赖 `renderedNodes` 的独立 `useLayoutEffect` 中调用 `marqueeSession.syncRenderedNodes()`；卸载时 `dispose`。
  - 移除 `onSelectionStart` / `handleSelectionStart`、`selectionMode`；`selectionOnDrag={false}`、`selectionKeyCode={null}`。
  - 在 `<ReactFlow>` 内渲染选框静态元素（`data-canvas-marquee`）。
  - 会话通过注入回调派发交互动作（`selection-start` / `click`），不直接依赖 React 上下文。
- `web/src/styles/globals.css`
  - `[data-marquee-hit]` 选中视觉与 z-index（组节点不参与抬升，保持既有沉底）；`[data-canvas-marquee]` 显隐（复用现有 `.react-flow__selection` 视觉）。
  - 手势光标由状态整体接管（规则 14）：框选取 `[data-canvas-marquee][data-active="true"]`（`default`），连线取 `data-interaction="connecting"`（`crosshair`），节点拖动取 `data-interaction="dragging-nodes"`（`grabbing`）；三者都对 `.react-flow` 子树整体写 `cursor` 并带 `!important`——逐元素枚举会漏掉边、节点内控件的内联 `cursor` 等 hover 目标（规则 14 要求「整块画布」不随命中跳变）。
- `web/src/features/canvas/hooks/use-canvas-interaction.ts`
  - 移除仅供内建框选使用的 `onSelectionStart` 包装（唯一调用方是 `InfiniteCanvas`；框选激活改由会话直接派发 `selection-start`）。
- `web/src/features/canvas/stores/canvas-store.ts`
  - 仅更新「框选（Shift 拖拽）」过时注释为「框选（空白区左键拖拽）」；无新 action（提交使用现有 `setNodes` / `setEdges` / `getCanvasProjectId`）。
- `web/src/features/canvas/shared/snap-engine.ts`、`shared/image-visibility.ts`、`shared/media-visibility.ts`
  - `Point`、`GEOMETRY_EPSILON`、`Rect` 改为从 `shared/geometry.ts` 复用；`SnapBounds` 作为领域别名保留（`type SnapBounds = Rect`）。
- `web/src/features/canvas/shared/edge-selection.ts`
  - 新增 `edgeTouchesSelection`：框选提交（写入边选中）与高亮派生（`canvas-derived.ts`）共用同一「任一端点选中」规则。
- `web/src/features/canvas/drag/drag-preview-session.ts`、`web/src/features/canvas/drag/drag-snap.ts`
  - 整组位移一致性改用 `samePoint`（修复刚性平移浮点末位差异导致聚合外框闪烁）。
- `web/src/__tests__/features/canvas/drag/drag-preview-session.test.ts`
  - 新增浮点末位差异回归。
- `specs/canvas-drag-preview-session.md`、`specs/canvas-snap-alignment.md`
  - 同步框选外框拖动走同一拖动 / 吸附链路的语义。
- `web/package.json`、`package-lock.json`
  - 新增 `@xyflow/system@0.0.83` 直接依赖（精确锁定），自动平移复用其 `calcAutoPan`；`src/__tests__/architecture/xyflow-version-lockstep.test.ts` 持续校验直接依赖版本与 `@xyflow/react` 声明一致。

### 依赖的 React Flow 契约（12.12，升级需重新验证）

- DOM：`.react-flow__pane`、`.react-flow__node[data-id]`、`.react-flow__selection`、`.react-flow__container`。
- store：`transform`、`panBy`、`elementsSelectable`、`connection.inProgress`、`nodesSelectionActive`。
- `@xyflow/system@0.0.83`：直接依赖并精确锁定，复用其导出的 `calcAutoPan`（与 React Flow Pane 自动平移同一实现）；升级 `@xyflow/react` 时必须同步升级该锁定版本并复验自动平移。
- 本仓库现有的 `.react-flow__nodesselection`、`.react-flow__node-toolbar` 契约不变。

## 异常与边界

- 点击（未越过阈值）：不产生写入，click 清空选区（现状）。
- 激活后提交空集：清空选区；选框隐藏；交互状态保持 `box-selecting`；已完成清空时不产生额外写入。
- 取消时原选区为空：无需恢复，直接清理。
- 手势中节点被删除 / 项目切换 / 远程同步写入：命中结果保持冻结；提交按当前节点过滤；内容所有者变化时不恢复取消快照。
- 手势中缩放、平移、自动平移：起点 flow 锚定；每帧重投影。
- 手势中指针移出窗口后松开：`blur` / `pointercancel` 取消；两者都未收到时，后续 `pointermove` 的 `buttons === 0` 兜底取消（候选阶段直接结束，不写 store）。
- 第二指针（多指）：取消本次手势，不提交。
- 连续手势：上一次提交尚未被渲染层采用时开始下一次，先强制完成上一次释放。
- 节点尺寸未测量（`measured` 缺失）：沿用 `measureNode` 的实测 → 显式尺寸 → 兜底链。
- 组嵌套（模型不允许）：按现有不变量处理，不新增嵌套语义。

## 验收标准

1. 框选过程（激活后）`nodes` / `edges` 引用不变，`handleNodesChange` / `handleEdgesChange` 不因框选触发；单测断言每帧 0 次 store 写入、整次手势仅激活清空与提交两次写入（无选区时不写）。
2. 指针帧按 rAF 合并，每帧最多一次选框样式写入；命中集合不变且视口未平移时不写 DOM 高亮属性。
3. 提交恰好一次；节点与边选中在同一次事件循环内完成；边写入带 `skipHistory`；框选后撤销栈不新增记录。
4. 语义：普通节点 Partial 命中；组完全包含才选中且排除成员；部分相交组的成员可单独选中；点击成员与框选成员结果一致。
5. 若确认追加：Shift/Ctrl/Meta 按下时保留原选区并追加；未按下时替换。
6. 边选择与现状一致（任一端点选中）；提交后点击空白清空选区与边选中。
7. 视觉：手势中显示虚线选框与 `--ring` 节点描边（含阴影与层级抬升）；聚合外框、工具栏、生成面板在激活时消失；提交后与现有选中态逐像素一致；明暗两套主题走查通过。
8. 取消：Esc / 失焦 / pointercancel 恢复手势前选区与聚合外框状态，不提交；项目切换后不恢复旧选区。
9. 手势后的 click 被抑制：不触发 `onPaneClick`（不关闭菜单、不 blur、不清空刚提交的选区）。
10. 低缩放（0.1）+ 1000 节点以上框选跟手，无明显掉帧或长任务；点击空白仍立即清空选区。
11. 中键/空格平移、触摸、右键菜单、连线进行中的行为不变。
12. 相关单测、类型检查、lint 通过；未覆盖项（真实浏览器低缩放性能、明暗主题视觉）由用户走查确认。
13. 光标：框选/节点拖动进行中，指针跨过节点与空白不跳变；手势结束后恢复 hover 派生光标（规则 14）。
14. 聚合外框：框选后从选区包围盒内空白按下并拖动即移动整组——节点同步位移、外框随组平移且拖动中不闪烁，松手提交位置并保留选区；框选只从包围盒外的空白起手（规则 1.5）。

## 已确认决策

用户于 2026-10-30 明确指示「先按照这个 spec 实施」，以下决策按建议方案确认：

1. **组语义**：采用即梦规则——只有完全包含的组才命中并排除其成员；部分相交的组不命中，其相交成员可单独命中。
2. **追加框选**：支持 Shift/Ctrl/Meta；`pointerdown` 时快照修饰键，手势中途按键不改变本次模式；追加 baseline 为当前已提交选中集。
3. **边选中**：保留「任一端点选中即选中该边」的现有语义；仅改为提交时一次性写入并 `skipHistory`。
4. **激活阈值**：保持 1px（Shift 时同样 1px，不再为 0）。
5. **聚合外框保留整组拖动**（2026-10-30 用户修正）：框选后从框内空白拖动必须移动整组。曾按「行业方案」把外框改为 `pointer-events: none`、让框内空白起框选，被用户明确否定（「框选之后，点击框选的位置（非节点），根本无法移动」），已回退为 React Flow 默认命中；框选从包围盒外的空白起手（规则 1.5）。

## 待确认事项

- 无未决业务规则或接口契约。
- 待用户走查：验收 7（明暗两套主题的预览与选中态视觉）与验收 10（0.1 缩放 + 1000 节点以上跟手性）；验收 13 / 14 已在真实页面验证。
- 实现尚未提交；commit / push 需用户明确确认（协作规则第六章）。

## 与现有 Spec 的关系

- `specs/canvas-drag-preview-session.md`：复用其会话模式、DOM 契约与「渲染层采用后释放」信号；本 Spec 处理该 Spec 明确排除的框选手势。
- `specs/canvas-snap-alignment.md`：外框拖动经 React Flow 默认 `useDrag` 进入拖动会话，整组移动正常参与吸附；该 Spec 对应条目已同步。
- `specs/canvas-undo-redo-integrity.md`：本 Spec 修复框选边选中污染历史的根因，选中态写入统一走 `skipHistory`。
- `specs/canvas-shared-module-convergence.md`：几何换算继续只经 `shared/group-bounds.ts`、`shared/tidy-layout.ts`；新增索引模块只做命中，不复制坐标规则。

## 当前状态

- 2026-10-30：状态保持「已确认」（未改为「已实现」）；用户明确授权按本 Spec 实施，决策按「已确认决策」执行。实现与自动化检查已完成，待用户浏览器走查与提交确认。
- 实现结果（已验证）：
  - 新增 `marquee/marquee-geometry.ts`、`marquee/marquee-session.ts` 及两个单测文件（共用 `fixtures.ts` 节点工厂）；`InfiniteCanvas` 接线会话、关闭内建框选并渲染选框静态元素；`globals.css` 增加预览高亮与选框显隐规则；`use-canvas-interaction` 移除 `onSelectionStart`；`canvas-store` 更新过时注释。
  - 单测：`marquee-geometry` 10 项 + `marquee-session` 30 项全部通过；相关回归（`stale-event-handler`、`stores`、`drag`、`shared`）合计 387 项通过；`tsc --noEmit` 无错误；`npm run lint` 0 error（6 条既有 `<img>` 警告）。新增的 1 项锁定规则 9.4：Esc 取消会先恢复快照，但会话不 `preventDefault`，冒泡阶段的全局 Escape 仍照常清空选区。
  - 两轴代码审查（Standards / Spec）后的根因修复：复用 `shared/dom.ts` 的 `isEditableTarget`（原实现自复制且漏判 contenteditable 祖先）；三处选中写入合并为 `writeSelection`（边写入统一 `skipHistory`）；手势快照前移到 `pointerdown`，并在激活时校验项目未切换；Esc 与 `pointercancel` 在候选阶段同样取消；取消顺序改为「恢复 → 清理预览 → 派发 click」；预览释放只等待节点渲染采用（边变化不影响预览）；索引查询草稿移入模块内部 `WeakMap`，冻结索引不再暴露可变状态。
  - 实现与规则的偏差已回写：click 抑制器为一次性、由「吞到一次 click」或「下一次 idle 按下」解除，不在提交释放预览时移除（React 同步渲染可能抢先卸载抑制器，规则 8.6/10）；`pointermove/up/cancel` 在候选开始时挂到 window，键盘/Space/blur/contextmenu 在 `attach` 时挂载（规则 2.2/3.4）；`contextmenu` 作为取消触发并独立于 blur 处理，避免误清 Space 状态（规则 9.1）。
  - 2026-10-30 走查反馈「移动时鼠标在抓手/指针间跳变、选框看起来消失又出现」：根因是光标由 hover 命中决定（节点 `grab`、空白 `default`、节点内按钮 `pointer`），手势期间随指针越界反复切换；已在 `globals.css` 改为手势状态整体接管（规则 14），覆盖节点全部后代；同类缺陷一并修到既有的连线进行中（`connecting` 也覆盖节点内控件）。真实页面合成指针验证：框选全程选框 `data-active=true`、`display:block` 且尺寸单调增长；指针位于节点按钮上时按钮/节点/空白光标同为 `crosshair`；取消后分别回到 `pointer` / `grab` / `default`；`dragging-nodes` 与 `connecting` 状态下节点内按钮同步为 `grabbing` / `crosshair`。同时确认 `data-interaction="box-selecting"` 是「最近一次选中来自框选」，选中后仍保留，不能用于判定手势进行中。
- 2026-10-30 第二次走查反馈「框选时指针一直是手、选框有时出现有时消失」：核对会话代码后确认**单次手势内选框不可能隐藏**（`resetGesture()` 只在提交释放、取消、卸载与下一次 idle 按下时调用；真实输入下的取消触发仅 Esc / blur / contextmenu / pointercancel / 丢失指针捕获 / 第二指针）；实际现象是不同次尝试的按下目标不同——按在聚合选中框或节点上不会进入框选（规则 1.1），光标保持 `grab`。
  - 实测（默认缩放下 3 个节点选中）：聚合选中框 `.react-flow__nodesselection` 是 `.react-flow__pane` 的子元素（`z-index:3`，高于 `z-index:2` 的视口），其 `-rect` 以 `pointer-events:all` 覆盖整个选区包围盒（含 40px 外扩与其中的节点）；对框内 203 个采样点逐一 `elementFromPoint`，203 个全部命中 `.react-flow__nodesselection-rect`（`cursor:grab`）。因此选区包围盒内的按下既不会启动框选，也不会命中其下节点——实测点击框内选中节点中心，选区不变。
  - 已修：手势光标实现由逐元素枚举改为整体接管（规则 14）。真实页面合成指针验证：框选进行中，即使节点内元素带内联 `cursor: nwse-resize`，命中元素也为 `crosshair`；结束后恢复 `default` / `grab` 与内联值。
- 2026-10-30 外框拖动定案与闪烁根因修复（用户修正已确认决策 5）：
  - 尝试与回退：曾把 `.react-flow__nodesselection-rect` 置 `pointer-events: none`、让框内空白起框选；用户明确否定「框选之后，点击框选的位置（非节点），根本无法移动」，已回退为 React Flow 默认命中。外框拖动经 XYDrag 触发 `onNodeDragStart`（`currentNode === undefined`，`currentNodes` 为全部已选节点）进入拖动会话，压历史并参与吸附（运行时已验证）。
  - 闪烁根因（已验证）：拖动会话按「吸附后位置 − 基准位置」反推每节点位移；同一段刚性平移加在不同基准位置上，浮点减法产生 ~1e-13 的末位差异（实测 dx = -5.68e-14 / -1.14e-13，dy = 0），`uniformSelectionDelta` 的严格相等把整组平移误判为混合位移，`applyOverlays` 每帧隐藏外框——与「框有时出现有时隐藏」一致。修复：一致性比较改用世界坐标容差（`shared/geometry.ts` 的 `GEOMETRY_EPSILON = 1e-6`，远大于浮点噪声、远小于可感知位移），并新增回归单测（按同一机制构造末位差异：基准 1.1 / 2.3，位移 2.547149699531246，位置反推差 ~4e-16）。
  - 浏览器实测（默认缩放，框选 t1/t3/t4 后从框内空白 `mousedown` + 逐帧 `mousemove`）：四帧外框 `visibility` 均为空（可见），`translate` 依次 `4px 3px` / `18px 11px` / `41px 26px` / `60px 40px` 跟随指针；`data-interaction=dragging-nodes`；松手后外框位于新位置、三节点仍选中，位置已提交。
  - `canvas-snap-alignment.md` 的对应条目已同步为「外框拖动进入拖动会话，正常吸附」。
- 2026-10-30 第三次走查反馈「框选的时候指针不用变成十字」：框选进行中的整画布接管光标由 `crosshair` 改为 `default`（仍整体接管，避免指针越过节点时跳回抓手/控件指针）；连线进行中保持 `crosshair`，节点拖动保持 `grabbing`。真实页面合成指针验证：框选激活时（选框 `data-active=true`、`display:block`）节点中心命中元素与空白光标均为 `default`；松手后节点回到 `grab`、空白 `default`。
- 2026-10-30 两轴代码审查（Standards / Spec）后的根因修复：
  - 组节点预览层级与最终选中态不一致（修复前实测：框选组时预览 `z-index` 为 `1000`，提交后选中组为 `-1`）：`[data-marquee-hit]` 的抬升排除组节点（`:not(.react-flow__node-group-node)`），预览与提交后视觉一致（规则 7.4）。修复后实测：框选 g1 时 `data-marquee-hit` 存在且组 `z-index` 为 `-1`，提交后选中组同为 `-1`；普通节点（t2/m1/m2）预览与提交后选中均为 `1000`。
  - 同类浮点比较：`applyEdges` 的同位移判定改用共享 `samePoint`，与 `uniformSelectionDelta` 同一容差，整组框选拖动时边不再回退到逐帧重算路径。
  - 公共化：`Point`、`GEOMETRY_EPSILON`、`samePoint` 提升到 `shared/geometry.ts`，snap 引擎、拖动会话、框选会话共用；删除框选会话本地 `Point` 及 `SNAP_EPSILON`、`UNIFORM_DELTA_EPSILON` 两处容差定义；`MarqueeSessionDeps` 统一为属性箭头函数签名。
  - 测试补充：无选区激活/提交不写 store；第二指针与丢失指针捕获取消并恢复选区；`stubRaf` 抽到 `__tests__/test-utils/raf.ts`。
  - 修复后浏览器复验（框选 t2/m1/m2 后从外框内空白拖动）：三节点同步位移 +60/+40，`data-interaction=dragging-nodes` 期间 `style.translate` 逐帧跟随；松手后选区保留；`Ctrl+Z` 精确回退 -60/-40，`Ctrl+Shift+Z` 恢复 +60/+40。
  - `canvas-drag-preview-session.md` 验收 3 中过时的「框选外框拖动不吸附」同步为整组走同一吸附链路。
- 2026-10-30 第三次两轴代码审查（Standards / Spec）后的根因修复：
  - 指针类型判定由黑名单（仅排除 `touch`）改为白名单 `mouse` / `pen`（规则 1.1）；未知指针类型不再被当作鼠标。
  - 提交时的最终选中集先按当前节点与 `selectable !== false` 过滤，再同时驱动节点、边与 `nodesSelectionActive`（规则 8.3 / 6.3）：手势中节点被锁定不会留下「外框激活但无选中节点」，也不会出现「端点未选中但边选中」。
  - 自动平移失败由静默吞掉改为 `console.warn("[marquee] 自动平移失败", error)` 诊断（仍不终止手势）。
  - `MarqueeRect` 并入 `shared/geometry.ts` 的 `Rect`；`stubRaf` 删除未使用的 `pending()`；`dispatchInteraction` 动作类型从 store 的 `InteractionAction` 派生；两处测试节点工厂收敛为 `fixtures.ts` 的 `marqueeBox`。
  - 测试补充（验收 11）：触屏 / 未知指针、中键、非主指针、连线中均不启动框选；手写笔正常启动；手势中节点变为不可选中时提交不选中且不激活外框；自动平移失败不终止手势。
  - `contextmenu` 保持 window 级监听（规则 9.1）：任何来源的右键菜单都视为接管，避免键盘菜单键（目标在画布外）打开菜单后手势仍继续；已有用例覆盖。
  - 技术影响清单补齐 `shared/geometry.ts`、snap / drag 改动、测试工具与关联 Spec。
  - 本轮检查：`tsc --noEmit` 无错误；`npm run lint` 0 error（6 条既有 `<img>` 警告）；`marquee` 40 项与相关回归 387 项全部通过。
- 2026-10-30 第四次两轴代码审查（Standards / Spec）后的根因修复：
  - 第二指针判定由容器级 `pointerdown` 移到手势期间的 window 级 `pointerdown`（规则 9.1）：第二根手指落在画布外（侧栏、工具条）同样取消；容器监听只负责空闲态起手。新增「画布外按下第二指针取消」用例。
  - 自动平移改为直接复用 `@xyflow/system` 导出的 `calcAutoPan`，删除本地逐项复制的 `calcAutoPan` / `autoPanVelocity` / `clamp`；`@xyflow/system` 以精确版本 `0.0.83` 声明为直接依赖（与 `@xyflow/react` 的依赖版本一致），升级 React Flow 时需同步升级并复验（见「依赖的 React Flow 契约」）。
  - `writeMarquee` 参数由四个数字收敛为 `Rect`；`MARQUEE_ACTIVATION_DISTANCE` 去掉无外部消费者的 `export`；`shared/geometry.ts` 补充「容差只用于等价判定、不用于阈值比较」的约束说明。
  - 本轮检查：`tsc --noEmit` 无错误；`npm run lint` 0 error（6 条既有 `<img>` 警告）；`marquee` 41 项（geometry 10 + session 31）与相关回归 387 项全部通过。
- 2026-10-30 第五次两轴代码审查（Standards / Spec）后的根因修复：
  - 指针在窗口外松开且未收到 `pointerup` / `blur` / `pointercancel` 时，后续 `pointermove` 的 `buttons === 0` 按取消兜底（候选阶段直接结束），不再无按键激活（异常与边界）。
  - 提交前校验手势快照的项目归属：项目在松手前切换时不写入新项目，也不恢复旧选区（规则 9.1）。
  - 激活阈值改为「严格大于 1px」：恰好等于阈值仍按点击处理，与 React Flow `paneClickDistance` 语义一致。
  - `dispose` 从 `attach` 时捕获的容器移除监听（不再重读 ref，避免容器替换后泄漏）；`writeSelection` 的节点/边克隆收敛为 `mapSelected`；`MarqueeGeometryEntry.group` 更名为 `isGroup`；测试工厂 `marqueeNode` 取消多余导出。
  - 测试补充：恰好阈值、候选/激活阶段 `buttons=0`、松手前项目切换。本轮检查：`tsc --noEmit` 无错误；`npm run lint` 0 error（6 条既有 `<img>` 警告）；`marquee` 45 项（geometry 10 + session 35）与相关回归 387 项全部通过。
- 2026-10-30 第六次两轴代码审查（Standards / Spec）后的根因修复：
  - 视口读取与 zoom 校验收敛为 `readViewport()`（候选起手、激活、每帧三处重复形状）。
  - `autoPan` 参数由四个标量改为 `Point` + `{ width, height }`，与 `calcAutoPan` 入参同形。
  - `releasePreview` 更名 `resetGesture`：该方法同时清理冻结索引、命中属性、选框、快照与基线，旧名只覆盖预览释放。
  - Spec 同步：`canvas-drag-preview-session.md` 规则 3.1 的「框选外框拖动不吸附」改为与验收 3 一致（整组走同一吸附链路）；`canvas-snap-alignment.md` 技术影响与本文技术影响中的 `SNAP_EPSILON` 更正为 `shared/geometry.ts` 的 `GEOMETRY_EPSILON`。
  - 测试补充（验收 2 / 6）：视口与指针未变化时不重复写选框与命中属性；提交时任一端点选中即选中该边。验收 3 的撤销栈由「会话传 `skipHistory`」+ store 既有 `skipHistory` 不压栈用例两层覆盖；验收 4 的框选侧由 `marquee-geometry` 的「部分相交只命中成员」覆盖，点击侧为 React Flow 既有行为未改动。
  - 本轮检查：`tsc --noEmit` 无错误；`npm run lint` 0 error（6 条既有 `<img>` 警告）；`marquee` 47 项（geometry 10 + session 37）与相关回归 387 项全部通过。
- 2026-10-30 第七次两轴代码审查（Standards / Spec）后的根因修复：
  - 边与选中的端点规则收敛为 `shared/edge-selection.ts` 的 `edgeTouchesSelection`：框选提交（`marquee-session`）与高亮派生（`canvas-derived`）不再各写一份「任一端点选中」判定。
  - 同形矩形类型收敛：`SnapBounds` 改为 `Rect` 的领域别名，`image-visibility` / `media-visibility` 的本地 `Rect` 改为复用 `shared/geometry.ts`。
  - `resetPointer` 更名 `endCandidate`：该方法覆盖候选阶段未达阈值、项目切换、视口非法三种结束路径，旧名只描述「指针重置」。
  - 新增 `src/__tests__/architecture/xyflow-version-lockstep.test.ts`：校验直接依赖的 `@xyflow/system` 与 `@xyflow/react` 声明的版本一致，升级 React Flow 时不同步会直接失败。
  - 未采纳：框选与拖动两个会话的 DOM wrapper 索引与 rAF 循环不合并——命中过滤（全量节点 + 选框 vs `affectedIds`）与帧语义（持续循环 vs 一次性合并）不同，强行抽取会把两种生命周期耦合在一起。
  - Spec 轴复审：未发现缺失、范围外行为或实现错误；验收 7/10 仍为浏览器走查项。
  - 本轮检查：`tsc --noEmit` 无错误；`npm run lint` 0 error（6 条既有 `<img>` 警告）；`marquee` 47 项、architecture 40 项与相关回归 443 项全部通过。
- 本次调查范围：本仓库框选/选择/拖动/历史链路、React Flow 12.12 内建框选实现、即梦线上 bundle 静态阅读。
- 已验证事实见「现状与已验证事实」与「业界对标」；即梦运行时行为未验证。

## 调查记录

- 本仓库：`InfiniteCanvas.tsx`（框选 props、点击/空白处理、拖动会话接线）、`canvas-store.ts`（setNodes/setEdges/历史/交互状态）、`canvas-derived.ts`、`drag/drag-preview-session.ts`、`shared/group-bounds.ts`、`shared/tidy-layout.ts`、`shared/group-membership.ts`、`styles/globals.css`。
- React Flow 12.12：`node_modules/@xyflow/react/dist/esm/index.mjs`（Pane 选择链路、NodesSelection 渲染条件、adoptUserNodes 抬升）、`@xyflow/system`（`getNodesInside`、`calcAutoPan`、`SELECTED_NODE_Z`）。
- 即梦：线上 bundle 静态阅读（指针会话、冻结索引、命中规则、追加 baseline、单次提交、click 抑制、canvas 预览）；未登录、未做运行时验证。
- 2026-10-30 按用户要求再次直连即梦站点：`jimeng.jianying.com` 被网络策略拦截（域名安全无法验证），未获得新证据；即梦「聚合框画在 canvas 画层、无 DOM 命中层」沿用既有 bundle 静态阅读，运行时行为未验证。该对照未采纳：用户要求保留框内拖动移动整组（已确认决策 5）。

# 画布多选聚合工具条

状态：已实现（Phase 1，2026-11-03；Phase 2 未实现，需另行确认）。2026-11-11/12
的组表面与批量连线增量为未提交改动，见第 9 节。

> 本 Spec 覆盖 Phase 1（本次实现）与 Phase 2（多选布局，后续扩展）。Phase 2 仅记录设计方向，不作为本次验收范围，需另行确认后才能实现。

## 1. 背景与证据

### 1.1 现状（2026-11-02 拆分前快照，读源码确认；`InfiniteCanvas.tsx` 已于 `a2f521c0` 删除，当前入口为 `root/CanvasSurface.tsx` / `root/overlays/GlobalOverlays.tsx`）

1. **多选时每个节点各挂一条工具条**：`web/src/features/canvas/InfiniteCanvas.tsx:1366` 遍历 `selectedNodeIds`，为每个选中节点渲染一条 `RfNodeToolbar` + `NodeToolbarUI`。选中 3 个节点就是 3 条；选中 129 个就是 129 条。
2. **选区装饰只在空闲态显示**：`web/src/features/canvas/hooks/use-canvas-interaction.ts` 的 `showSelectionChrome = interaction.mode === "idle"` 是调查时唯一的可见性真相源。框选会话激活即进入 `box-selecting` 并隐藏装饰；调查时 `MarqueeSession.commit()` 只写入选区、不派发交互动作，因此框选松手后状态仍停留在 `box-selecting`，直到下一次点击才回到 `idle`——并非「松手即回到 idle」。这是聚合工具条「松手后出现」必须先拆分交互状态的原因（见 4.1 与第 9 节）。
3. **现有选区外框不覆盖组节点**：`web/src/features/canvas/shared/canvas-derived.ts:185` 的 `computeSelectionFrame` 只统计 `!isGroupNode` 的选中节点，且少于 2 个时返回 null。它服务于批量连线（`InfiniteCanvas.tsx:1391` 的 `BatchConnectHandle`），不能直接作为聚合工具条的锚点：选中两个组时它为空；选中“组 + 散节点”时，散节点不足 2 个也为空，散节点 ≥2 个则只覆盖散节点。
4. **编组 / 解组已有完整动作**：`web/src/features/canvas/hooks/use-group-operations.ts:92` 监听 `CANVAS_GROUP_NODES`，过滤掉组节点后要求至少 2 个；`:136` 监听 `CANVAS_UNGROUP_NODES`，解组所有选中组。键盘入口在 `web/src/features/canvas/hooks/use-canvas-keyboard.ts:172-181`。
5. **复制 / 创建副本 / 删除已有完整动作**：`web/src/features/canvas/shared/canvas-edit-actions.ts:97` 的 `copySelection()`、`:139` 的 `duplicateSelection()`、`:468` 的 `deleteSelection()`。删除组会级联删除成员（`canvas-store.ts:455` 的容器型语义），解组则保留成员。
6. **多选没有统一动作入口**：节点右键菜单只有复制 / 创建副本 / 粘贴 / 删除（`web/src/features/canvas/controls/CanvasContextMenu.tsx:181-230`），没有编组 / 解组；编组目前主要靠快捷键和组节点自己的工具条，发现性低。
7. **多选布局不存在**：`web/src/features/canvas/shared/group-layout.ts:29` 的 `GroupLayoutMode` 与 `arrangeGroup` 只处理组内相对坐标与组框尺寸，不能直接用于任意选中节点。
8. **多选 per-node 工具条有可量化成本**：`specs/canvas-selection-chrome-scheduling.md:78` 记录 Ctrl+A 选中 129 节点时新增约 642 个元素（约 5 个/节点），出现 273ms + 109ms 长任务。聚合工具条可以直接消掉每个节点各挂一条工具条的 DOM 与挂载成本。

### 1.2 即梦对照（已验证事实，2026-11-02 实机观察）

在用户已登录的即梦画布（React Flow 12.x，视口约 2560×1305，缩放 50%）上做了一次只读框选观察：

1. **框选拖动中**：已提交选中节点数为 0，没有出现任何工具条；框选预览只在画布层。
2. **松手后**：选中 3 个节点，出现一条聚合工具条，约 470×40px，水平居中于选区上方。可见文案与元素依次为：
   - `3 节点`（计数）
   - `堆叠`
   - `编组`
   - `布局`
   - 下载图标（`aria-label="下载"`）
3. **选区右缘**：另有 36×36 的“创建后续连线节点”按钮，位置和语义对应本仓库已有的 `BatchConnectHandle`；工具条下方另有一个 `Add tags`，不在同一条内。
4. **点空白**：选区清空，工具条卸载。
5. **单选对照**：此前的被动观察显示，单选时是节点自己的工具条；多选才切换为聚合工具条。

未验证部分：

- `堆叠` 的实际行为没有点击，语义未知。
- 下载按钮的批量行为（逐个下载 / 打包 / 混合媒体）没有触发。
- 即梦在“选中组”“组 + 散节点混合选择”下的工具条按钮没有验证。
- 工具条在所有缩放/选区贴边场景下的锚点与钳制规则没有穷举。

### 1.3 取舍

| 即梦行为 | 本 Spec 是否采用 | 说明 |
| --- | --- | --- |
| 框选拖动中不显示工具条 | 采用 | 本仓库 `showSelectionChrome` 已是同一时序，无需新增手势判断 |
| 松手多选后出现单条聚合工具条 | 采用 | Phase 1 核心 |
| 左端显示选中数量 | 采用 | 只读计数，不作为按钮 |
| 编组 | 采用，产品文案统一为“编组” | 现有 `common.group` 的中文原为“分组”，本次统一改为“编组”；同时更新 `node.group`、`node.groupWithCount`、`shortcuts.group`、`shortcuts.desc.group`，避免同一动作多处叫法不一致 |
| 布局 | Phase 2，本次不实现 | 需要先把组内布局算法泛化为选区级布局 |
| 下载 | 不采用（Phase 1） | 批量下载涉及混合媒体、打包、命名、失败处理，需独立 Spec |
| 堆叠 | 不采用 | 语义未验证，本仓库没有对应能力，不凭标签猜 |
| Add tags | 不采用 | 画布节点没有标签模型，和资产标签不是同一领域 |
| 右缘“创建后续连线节点” | 保留现有 `BatchConnectHandle` | 不在工具条里重复 |
| 组节点的颜色 / 组内布局 | 保持单选入口 | 多选时聚合工具条不承载组专属动作，避免混合选区语义不清 |
| 工具条水平居中于选区上方 | 采用 | 选区贴边时钳制到视口内 |
| 40px 高度 | 不照搬 | 沿用现有 `NodeToolbar` 的 `Card` 50px 高度与视觉体系 |

### 1.4 需求确认状态

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 用户要求编写本 Spec | 已确认 | 用户消息“写spec吧” |
| 全部推荐方案（第 8 节） | 已确认（2026-11-02） | 用户表示“都按你推荐的来” |
| 产品术语使用“编组” | 已确认（2026-11-02） | 用户明确要求；工具条、组节点与快捷键面板统一 |
| 采用“提交后单条聚合工具条” | 已确认（2026-11-02） | 用户明确表示全部按推荐方案执行 |
| Phase 1 按钮集：计数 / 编组 / 解组 / 创建副本 / 更多 | 已确认（2026-11-02） | 全部复用现有动作，不新增布局算法 |
| 多选布局放入 Phase 2 | 已确认（2026-11-02） | 见第 10 节，不作为本次验收范围 |
| 下载 / 堆叠 / 标签 / 对齐分布不进入 Phase 1 | 已确认（2026-11-02） | 见 1.3 与 3.2 |

## 2. 目标

1. 画布多选（≥2 个节点）时只显示一条聚合工具条，替代当前每个选中节点各挂一条工具条的实现，降低 DOM 规模与视觉噪音。
2. 为多选提供统一、可发现的“编组 / 解组 / 创建副本 / 复制 / 删除”入口，不改变这些动作现有的节点内容、分组归属与连线语义；剪贴板载荷的运行时字段/上传会话剥离由 `specs/canvas-clipboard.md` 统一。
3. 单选行为保持不变：仍使用节点自己的工具条。
4. 工具条只在交互空闲态出现；框选、拖节点、拖线期间不出现，不重新引入选中/起拖卡顿。
5. 工具条锚定选区容器框（普通多选为节点并集四边外扩 40px，顶部再加标题带 28px；选中的全是组时为组自身并集），屏幕像素固定尺寸，随视口平移/缩放跟随，并在贴近视口边缘时钳制。
6. Phase 1 不引入新的布局算法、批量下载、标签或对齐分布能力。

## 3. 范围

### 3.1 包含（Phase 1）

- 新增聚合工具条组件与渲染层。
- 新增“所有选中节点（含组）”的选区包围盒派生，并统一多选外框显隐与工具条锚点（`bbox` / `frameVisible` / `containerBbox`），区别于现有只服务批量连线的 `selectionFrame`。
- 聚合工具条显示规则：选中节点数 ≥2 且交互已提交（idle 或 box-selected）。
- 工具条按钮：计数、编组 / 解组、创建副本、更多（复制 / 删除）。
- 多选时抑制所有 per-node 通用工具条；媒体编辑面板等独立渲染路径不变。
- 工具条的锚点、屏幕固定尺寸、视口钳制、平移/缩放跟随。
- 键盘可达性、Esc 与菜单的交互、无自动抢焦点。
- 中英文文案、明暗主题、组件测试、派生函数单测、性能回归验证。

### 3.2 不包含

- 多选布局（智能 / 宫格 / 水平 / 垂直），见第 10 节 Phase 2。
- 批量下载、打包下载。
- 画布节点标签 / 资产标签。
- 对齐、分布、堆叠。
- 单选节点工具条的任何行为调整。
- 组节点的颜色、组内布局在多选工具条中的入口。
- 框选手势本身与 `selectionFrame` 的行为调整；批量连线拖拽会话（含
  `BatchConnectHandle` / `GroupConnectRail`）的规则见
  `canvas-batch-connect-drag.md` 规则 1「起手」至规则 6「清理」。
- 画布数据结构、数据库、服务端接口或存储格式变更。

## 4. 业务规则

### 4.1 可见性

1. 聚合工具条仅在 `selectedNodeIds.size >= 2`、交互已提交（`interaction.mode === "idle"` 或 `"box-selected"`）且没有媒体编辑面板 / 文本编辑态打开时显示。编辑态判断复用现有 `isMediaEditorOpenState` 与 `editingTextNodeId`，不新增状态源。
   - `idle`：点击选中（含点击空白清空后的空闲态）。
   - `box-selected`：框选手势已结束、选区已写入的提交态。框选手势本身是 `box-selecting`，提交后必须转入此态，否则工具条要等到下一次点击才出现，违反 7.2「松手后出现」。
   - 节点工具栏（per-node 与聚合）共用 `showSelectionToolbars = idle | box-selected`；生成面板等重装饰仍只认 `showSelectionChrome = idle`，避免框选松手瞬间弹出生成面板。
2. 以下状态不显示：
   - 框选手势进行中（`interaction.mode === "box-selecting"`）；
   - 拖动选中节点进行中；
   - 拖拽连线进行中；
   - 选区清空；
   - 仅选中连线、没有 ≥2 个选中节点。
3. 单选（`selectedNodeIds.size === 1`）继续显示现有节点工具条，不显示聚合工具条。框选提交后只剩 1 个选中节点时同样显示该节点工具条；点击单选的既有行为不变。
4. 媒体编辑面板 / 文本编辑态本身是单目标编辑现场；正常路径进入编辑态时选区收敛为 1，因此不满足 ≥2。作为防御性规则，若程序化状态导致 ≥2 与编辑态并存，聚合工具条隐藏，避免覆盖编辑现场。
5. 选区与视口完全无交集时隐藏工具条，避免工具条贴在视口边缘指向不可见内容；部分可见时按 4.7 钳制。

### 4.2 计数

1. 左端显示只读计数，文案建议 `{{count}} 个节点`（英文 `{{count}} nodes`），使用新增 i18n key。
2. 计数只统计选中节点，包含组节点；选中连线不计入。工具条本身只在节点数 ≥2 时出现，因此不存在“只选连线”的计数场景。
3. 计数不响应点击，不打开菜单，不进入 Tab 焦点序列；建议使用 `aria-live="polite"`，选区变化时向辅助技术播报。

### 4.3 编组 / 解组

1. 设 `selected` 为当前选中节点集合，`hasGroup = selected.some(isGroupNode)`。
2. **全部为非组节点且数量 ≥2**：显示“编组”（复用 `common.group`），点击派发 `CANVAS_GROUP_NODES`。
3. **选中项含任意组节点**：显示“解组”（复用 `common.ungroup`），隐藏“编组”，点击派发 `CANVAS_UNGROUP_NODES`。
4. 混合选择（组 + 非组节点）不提供“编组”。现有 `onGroupNodes` 会过滤掉组节点，只把非组节点编入新组；如果按钮仍显示“编组”，用户会误以为整组被编入。该规则是本 Spec 的明确产品决策。
5. 解组沿用现有语义：解组所有选中组，组成员恢复到顶层并保持选中；原本选中的非组节点保持选中；组相关连线清理。
6. 动作完成后的选区变化：
   - 编组完成后，新组成为唯一选中项，聚合工具条卸载，显示新组的节点工具条。
   - 解组完成后，若剩余选中项仍 ≥2 且不含组，聚合工具条保留并切换为“编组”；若只剩 1 个，聚合工具条卸载，显示该节点的工具条。
7. 不新增编组/解组业务逻辑，不改变“组不嵌套组”“空组即删”等既有语义。

**按钮显示矩阵（Phase 1）**：

| 选区 | 计数 | 编组 | 解组 | 创建副本 | 更多 |
| --- | --- | --- | --- | --- | --- |
| ≥2 个节点，全部非组 | 显示 | 显示 | 隐藏 | 显示 | 显示 |
| ≥2 个节点，含任意组节点 | 显示 | 隐藏 | 显示 | 显示 | 显示 |
| 1 个节点 | 聚合工具条整体隐藏，沿用该节点工具条 | — | — | — | — |
| 0 个节点 / 仅选中连线 | 聚合工具条整体隐藏 | — | — | — | — |

### 4.4 创建副本

1. 选中节点数 ≥2 时显示“创建副本”（复用 `common.duplicate`），点击调用 `duplicateSelection()`。
2. 沿用现有语义：复制当前选区（选中组时带全部成员）、在右下方偏移 `LAYOUT_GAP` 落位、副本保持选中、只还原上游连线（含集内边）。
3. 副本生成后选区切换为副本；若副本仍 ≥2 个节点，聚合工具条保留并按新选区重算按钮。
4. `duplicateSelection()` 返回 false 时按无操作处理，不新增错误提示；Phase 1 不引入新的反馈 UI。
5. `Ctrl+D` 快捷键保持不变，并与工具条按钮共用同一动作实现。

### 4.5 更多菜单

1. “更多”使用 `DropdownMenu`，菜单项为：
   - 复制（`common.copy`）：调用 `copySelection()`；
   - 删除（`common.delete`）：调用 `deleteSelection()`。
2. 删除沿用现有语义：删除选中节点及选中连线；删除组会级联删除成员；不取消关联的生成任务。不新增确认弹窗，与 Delete 键、节点右键菜单的现有行为一致。
3. 菜单项选择后关闭菜单；焦点按现有 `DropdownMenu` 约定回到触发器。
4. 工具条内菜单打开期间，若选区发生变化（节点增删、清空、编组/解组/副本导致选区替换），菜单必须关闭，避免对旧选区执行动作。
5. “下载”不进入 Phase 1 的更多菜单。

### 4.6 单节点工具条抑制

1. `selectedNodeIds.size >= 2` 时，`CanvasSurface` 不再为任何选中节点渲染通用 `NodeToolbarUI`。
2. 媒体编辑面板（帧序列、片段截取、音频截取、打光、多视角、全景、标注、裁剪等）的渲染路径不变；这些面板是单目标编辑现场，正常不会与 ≥2 选区并存。
3. 多选时组节点的颜色 / 组内布局入口不可用；用户单击该组进入单选后继续使用组节点工具条。这是 Phase 1 的已知取舍。
4. 单选时完全保持现有 per-node 工具条行为，不改变其内容、位置或动作。

### 4.7 锚点与定位

1. 新增“聚合工具条包围盒”派生 `selectionChromeBounds`：按所有选中节点（含组节点）的绝对坐标与 `measureNode` 尺寸求并集；少于 2 个选中节点时为空。实现放在 `shared/canvas-derived.ts`，与 `selectionFrame` 并列，但**不复用** `selectionFrame`，因为后者只统计非组节点。字段：
   - `bbox`：选中节点的原始并集（flow 坐标），作为几何基准；
   - `frameVisible`：多选外框是否可见，等价于「≥2 个选中且不全是组节点」；画布的外框显隐直接消费该字段，不再单独扫描选区；
   - `containerBbox`：工具条锚点。`frameVisible` 为 true 时是 `bbox` 四边向外扩 `GROUP_NODE_PADDING`(40px)，顶部再加标题带 `NODE_TITLE_HEIGHT`(28px)，合计 68px；工具条因此比可见框再高一个标题高度，编组后组标题不会与工具条重叠；为 false（选中的全是组）时等于 `bbox`，因为组节点自身已包含标题带与 40px body 内边距，且外框被隐藏。
2. 工具条可见性按 `bbox` 与视口的交集判定（见 4.1-5），标题带与外框内边距不算可见内容；在屏幕坐标中定位时锚定 `containerBbox`（选区外框 + 顶部标题带）：
   - 优先放在容器框上方，水平居中；
   - 与 `containerBbox` 保持固定视觉间距 12px；对可见框而言，顶部实际让出 `12px + 28px × zoom`（标题带 28px×zoom + 间距 12px）；
   - 上方空间不足时放到下方；
   - 水平方向按工具条实际宽度钳制在画布视口内，左右各留至少 8px；
   - 垂直方向钳制在视口内，不遮住画布顶部工具栏。
3. 工具条尺寸使用屏幕像素，不随画布缩放变小。50% 缩放下仍保持 50px 高度，不放进随视口缩放的节点层 / `ViewportPortal` 后直接缩放。
4. 跟随触发：选区变化、视口平移/缩放、工具条自身尺寸变化（ResizeObserver 或等效测量）。框选/拖动期间工具条隐藏，不参与逐帧跟随。
5. 不与右缘 `BatchConnectHandle` 重叠；若空间冲突，优先保证工具条在上方/下方可见，批量连线仍由现有轨道独立渲染。
6. 画布容器局部层级使用现有画布常量体系，不新增全局 z-index、Portal 容器或层级兜底；菜单/浮层继续走现有 `DropdownMenu` Portal。

### 4.8 交互与键盘

1. 工具条容器使用 `nodrag nopan`，并阻止指针事件冒泡到画布，避免点击按钮时开始框选、拖动节点或平移画布。
2. 工具条挂载时不自动抢焦点；画布键盘快捷键（方向键微调、Delete、Ctrl+D、Ctrl+G 等）在工具条存在时继续可用。
3. Tab 顺序：编组/解组 → 创建副本 → 更多；计数不进入焦点序列。
4. Esc 行为：
   - 工具条内菜单打开时，第一次 Esc 只关闭菜单，不清空画布选区；
   - 菜单关闭后再次 Esc，按现有画布行为清空选区并卸载工具条。
5. 按钮使用现有 `aria-label` / `title` 约定：文字按钮直接使用可见文案，图标按钮必须有可访问名称。「更多」刻意不使用 `Tooltip`——Radix Tooltip 在焦点回到触发器时会立即打开并用 `preventDefault` 吞掉下一次 Esc，破坏 4.8-4 的 Esc 约定；改用 `title` + `aria-label`。其余文字按钮不需要 Tooltip。
6. 工具条内动作执行后，按 4.3 / 4.4 / 4.5 的选区变化规则更新或卸载；不在动作中途重复触发。

### 4.9 历史与状态

1. 编组、解组、创建副本、删除继续使用现有动作的历史策略：一次用户动作对应一条可撤销记录，不新增中间快照。
2. 工具条可见性、菜单位置、展开状态都是瞬态 UI，不写入画布文档、不进撤销历史、不落库。
3. 撤销/重做按现有快照恢复；恢复后工具条按新的选区状态重新计算，不保留旧选区的菜单。

### 4.10 视觉与文案

1. 复用现有 `NodeToolbar` 的 `Card`（`min-h-[50px]`、`flex-wrap`、`rounded-xl`、`px-2.5 py-1.5`）、`Button`、`Separator`、`DropdownMenu` 体系，不新造一套视觉。`min-h` 允许窄视口下按钮行换行增高；容器最大宽度 = 视口宽度 − 2 × `SELECTION_TOOLBAR_VIEWPORT_EDGE`(8px)，由 `SelectionToolbarLayer` 注入，换行后尺寸经 `ResizeObserver` 重新测量并重算位置。
2. 主行动作使用图标 + 文字按钮：`编组` / `解组`、`创建副本`；`更多` 使用图标 + `title` / `aria-label`（见 4.8-5，不使用 Tooltip）。图标从 `components/ui/AppIcon` 获取（编组 `GroupIcon`、解组 `UngroupIcon`、创建副本 `DuplicateIcon`），随按钮文字使用 `currentColor`；右键菜单的 `创建副本` 使用同一 `DuplicateIcon`，两个入口保持一致的复制语义；具体视觉在实现时按现有按钮尺寸校准，不改变既有组件契约。`GroupIcon` 的图形替换（用户提供的 16×16 SVG）同时作用于聚合工具条、组节点标题与 `NodeTypeDisplayMeta` 的组类型图标，三处保持同一视觉。
3. 文案复用：
   - `common.group`（中文“编组”）
   - `common.ungroup`（中文“解组”）
   - `common.layout`（中文“布局”，Phase 2 使用）
   - `common.duplicate`（中文“创建副本”）
   - `common.copy`（中文“复制”）
   - `common.delete`（中文“删除”）
   - 新增计数 key，例如 `canvas.selection.count`。
4. 颜色、边框、焦点、悬停状态全部使用主题 token；明暗主题下均需验证对比度。
5. 不使用硬编码颜色、内联遮罩或第三方图标库；图标从 `components/ui` 出口获取。
6. 现有 `node.group`、`node.groupWithCount`、`shortcuts.group`、`shortcuts.desc.group` 的中文值同步改为“编组”，不保留旧叫法；英文保持 `Group`。
7. 选区外框与组节点视觉对齐：拖拽框与持久外框统一使用 `var(--radius)` 圆角（与组 body 的 `rounded-lg` 同源，当前为 10px）；持久外框填充使用独立的半透明中性 token `--selection-frame-bg`（4% 白），不复用组表面（`--canvas-group-bg`，不透明，复用会盖住框内节点）；拖拽框保持更淡的 `--marquee-bg` 与虚线，保留「进行中 / 已提交」的阶段区分；两者边框继续使用 `--marquee-border`，保证外框在组填充之上仍可辨认。
8. 组节点的可见框与框选外框对齐：编组几何是成员并集向外扩 `GROUP_NODE_PADDING`(40px)，组标题栏（`NODE_TITLE_HEIGHT`=28px）留在组 body 之外，因此组节点顶边 = 成员并集顶 − (28 + 40) = −68px，组 body 的可见顶边 = 成员并集顶 − 40px。框选外框采用同一口径：四边均外扩 40px（`padding: 40px; margin: -40px`）。这样框选提交后立即编组时，两框的可见顶边、底边、左右边完全重合；组标题保持在框外，不进入组的填充/描边/选中环。工具条锚点 `containerBbox` 与可见框分离：其顶部为可见框 40px 再加标题带 28px（合计 68px），让工具条落在未来组标题的上方，不与标题重叠。
9. 统一边距（2026-11-02，用户确认「编组之后，里面的内容距离四周应该和布局之后一样，包括框选的时候」）：编组、组内布局、框选统一为「标题带在 body 外 + body 四边 40px」。编组创建改为 `groupY = minY - NODE_TITLE_HEIGHT - GROUP_NODE_PADDING`、`groupH = unionH + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING * 2`，成员绝对位置不动，组框向上多扩 28px；组内布局的 `LAYOUT_ORIGIN.y = NODE_TITLE_HEIGHT + GROUP_NODE_PADDING` 已是目标口径，不改；框选外框改为四边 40px。该决策取代此前「顶部 12px、刻意不对称、不追求四边 40px」的取舍。旧组不自动迁移，执行一次组内布局后归一为 40px。refit 的顶部扩张同样计入标题带：成员探出组顶时按 `memberY − NODE_TITLE_HEIGHT − GROUP_NODE_PADDING` 计算新组顶，使成员落到 body 顶缘下方 40px；左/右/底部仍按 40px。
10. 组表面与拖线态：组 body 常态背景为 `--group-surface`，视觉上不透明（默认组取 `--canvas-group-bg`，彩色组为 `color-mix(in srgb, tint 16%, var(--canvas-group-bg))`，见 `getGroupSurfaceBackground`）；`.react-flow[data-connecting]` 期间背景改为 `color-mix(in srgb, var(--group-surface) 20%, transparent)`，标题与描边保持不透明。该规则对齐即梦 `.is-connecting ... opacity-canvas-group-connection-preview`（`opacity: .2`）；拖线态对点阵可见性的影响见 `canvas-dot-grid.md` 规则 6「组表面上的点阵可见性」。

## 5. 技术影响

### 5.1 数据派生

- 在 `web/src/features/canvas/shared/canvas-derived.ts` 增加 `selectionChromeBounds`，由全部选中节点的绝对坐标与 `measureNode` 计算，随 `nodes` 引用缓存。字段包含 `count`、`hasGroup`、原始并集 `bbox`、外框显隐 `frameVisible` 与工具条锚点 `containerBbox`。
- `frameVisible` 与多选外框显隐同源：`CanvasSurface` 直接消费该字段，删除原先独立的选区扫描 memo。
- 保留 `selectionFrame` 原语义与调用方不变；批量连线继续使用它。
- 不新增 store 字段，不改变画布文档结构。

### 5.2 组件与渲染

- 新增 `web/src/features/canvas/controls/SelectionToolbar.tsx`：
  - 展示层 `SelectionToolbar`：接收计数、是否含组、选区签名与回调，渲染 `Card`。
  - 容器层 `SelectionToolbarLayer`：订阅选区、视口与包围盒，计算屏幕坐标并渲染浮层。
- `web/src/features/canvas/root/CanvasSurface.tsx`：
  - 用 `selectCanvasToolbarMode(showSelectionToolbars, selectionChromeBounds)` 得到唯一可见模式：`hidden` / `aggregate`（携带 `bounds`）/ `per-node`，不再在渲染层重复 `multiSelect = selectedNodeIds.size > 1` 阈值；
  - 把 `toolbarMode` 交给 `CanvasOverlays`；`aggregate` 且无编辑现场时由 `root/overlays/GlobalOverlays.tsx` 渲染 `SelectionToolbarLayer`；`per-node` 时保留 per-node 通用 `NodeToolbarUI`；
  - `.hide-selection-rect` 直接使用 `canvasDerived.selectionChromeBounds?.frameVisible`，删除重复的选区扫描与 `every(isGroupNode)` 判断，保证外框显隐与工具条锚点同源；
  - 媒体编辑面板的独立 `RfNodeToolbar` 渲染块保持不变。
- 工具条展示层接收 `selectionKey`，只作为「更多」菜单的 `key`：选区变化时菜单子树重挂载并关闭，展示层本身不重挂载，`aria-live` 计数节点保留。
- 工具条层使用独立组件订阅视口，避免 `CanvasSurface` 因平移/缩放整体重渲染；工具条可见的已提交态（idle 或 box-selected）均随视口重算锚点，仅框选/拖动进行中隐藏、不参与逐帧跟随。
- 使用 `useViewport()` 或等效的 viewport transform 把 `containerBbox` 与 `bbox` 从 flow 坐标投影到画布容器坐标：前者用于定位，后者只用于判定与视口是否有交集；不把工具条放进随视口缩放的节点层。

### 5.3 复用现有动作

- 编组 / 解组：派发 `EventNames.CANVAS_GROUP_NODES` / `EventNames.CANVAS_UNGROUP_NODES`，不新增事件。
- 术语统一：只改 i18n 文案值，不改 key；`common.group`、`node.group`、`node.groupWithCount`、`shortcuts.group`、`shortcuts.desc.group` 的中文统一为“编组”，`common.ungroup` 保持“解组”，英文保持 `Group`。
- 创建副本 / 复制 / 删除：直接调用 `duplicateSelection()` / `copySelection()` / `deleteSelection()`，不复制实现。
- 键盘快捷键与工具条共用同一动作函数，不产生两套语义。
- 不修改 `use-group-operations.ts` 的归属变换与历史逻辑；`canvas-edit-actions.ts` 的剪贴板协议已由 `specs/canvas-clipboard.md` 取代（删除语义不变），不再使用旧 `noxrea-nodes:` 文本载荷。

### 5.4 测试

新增或补充：

- `web/src/__tests__/features/canvas/shared/canvas-derived.test.ts`：聚合包围盒包含组节点、成员绝对坐标、空选区、单选返回空。
- `web/src/__tests__/features/canvas/controls/SelectionToolbar.test.tsx`：按钮显示矩阵（全非组 / 含组 / 混合 / 2 组）、计数、菜单项、Esc 行为、无自动聚焦。
- `web/src/__tests__/features/canvas/root` 相关测试或等价集成测试：多选时不渲染 per-node 工具条、单选时保持原行为。由于 `CanvasSurface` 的依赖面过大，等价实现是把可见性规则抽成纯函数 `selectCanvasToolbarMode`，在 `canvas-derived.test.ts` 覆盖 `hidden` / `aggregate` / `per-node` 三种模式；渲染层只消费该结果。
- `SelectionToolbar.test.tsx` 额外覆盖：选区变化关闭「更多」菜单但保留 `aria-live` 计数节点；工具条容器按视口宽度设置 `maxWidth`，配合 `flex-wrap` 不溢出。
- 现有 `web/src/__tests__/features/canvas/hooks/use-group-operations.test.ts` 与 `web/src/__tests__/features/canvas/shared/group-layout.test.ts` 保持通过，证明未改变编组/布局语义。
- 性能回归：129 节点 Ctrl+A 后只挂 1 条聚合工具条，per-node 工具条数量为 0；与 `specs/canvas-selection-chrome-scheduling.md` 记录的基线对比，不出现新的长任务回归。

## 6. 异常与边界

1. **只选连线**：不显示聚合工具条；现有连线选中态不变。
2. **1 个节点 + 若干连线**：不显示聚合工具条，保持单节点工具条。
3. **2 个组**：显示计数、解组、创建副本、更多；不显示编组；包围盒包含两个组的完整尺寸。多选外框隐藏，工具条锚定两个组的原始并集（组已包含 40px 内边距）。
4. **组 + 非组节点**：显示计数、解组、创建副本、更多；不显示编组（见 4.3-4）。多选外框可见，工具条锚定并集四边外扩 40px，顶部再加标题带 28px。
5. **组内成员被单独选中**：按普通选中节点计入数量与包围盒；若同时选中其父组，按普通并集处理，不重复移动。Phase 1 不提供多选布局，因此不涉及成员相对坐标重排。此时：
   - 编组沿用现有语义：成员从原组移入新组，原组变空则按“空组即删”清理；
   - 创建副本沿用现有语义：父组不在剪贴板内时，成员展平为顶层副本；
   - 删除沿用现有语义：组内成员被删除后，空组按“空组即删”清理。
6. **选区部分移出视口**：工具条钳制在视口内；选区完全移出视口时隐藏。
7. **选区在画布顶部**：上方空间不足时放到选区下方；再不足时钳制到视口内。
8. **工具条宽度超过视口**：按钮行使用 `flex-wrap` 换行，容器最大宽度为视口宽度减左右各 8px；换行导致高度变化时由 `ResizeObserver` 重新测量并重算位置，不横向溢出，也不引入横向滚动。
9. **菜单打开时选区变化**：关闭菜单（见 4.5-4）。
10. **删除 / 解组导致工具条自身卸载**：动作完成后由选区状态驱动，不在卸载过程中再次派发动作。
11. **生成中的节点**：编组、解组、副本、删除沿用现有动作对生成任务的语义；本 Spec 不新增拦截或取消任务逻辑。
12. **撤销 / 重做**：按现有快照恢复；工具条不保留旧菜单或旧锚点。

## 7. 验收标准

### 7.1 功能

- [x] 选中 2 个非组节点：只出现 1 条聚合工具条；显示计数、编组、创建副本、更多；不出现 2 条 per-node 工具条。
- [x] 选中 3 个节点：只出现 1 条聚合工具条，计数为 3。
- [x] 选中 2 个组：只出现 1 条聚合工具条；显示解组，不显示编组；解组后成员恢复选中（2 组 → 6 名成员全部选中，撤销恢复 131 节点）。
- [x] 选中 1 个组 + 1 个非组节点：显示解组，不显示编组；解组后非组节点仍选中（解组后共 3 个节点选中，撤销恢复组与 131 节点）。
- [x] 选中 1 个节点：保持现有节点工具条，不出现聚合工具条（视频节点 per-node 工具条 404×50，9 个按钮）。
- [x] 只选中连线：不出现聚合工具条（仅 `e-scVxfkKyI1LfI` 被选中，无节点选中）。
- [x] 创建副本：副本按现有规则偏移并选中；工具条随新选区更新（131 → 133，计数 2；撤销/重做 133 → 131 → 133 → 131）。
- [x] 更多 → 复制：写入系统剪贴板，选区不变（选区仍为 2 节点；系统载荷改为独立 Noxrea 画布选择格式，自定义 MIME + HTML 镜像，纯文本选择才附带 `text/plain`，旧 `noxrea-nodes:` 文本载荷已移除，详见 `specs/canvas-clipboard.md`）。
- [x] 更多 → 删除：删除选中节点/连线；组删除级联成员；工具条卸载（131 → 129，选区清空，工具条卸载；撤销恢复 131）。
- [x] 编组 / 解组 / 副本 / 删除各产生一条可撤销记录，撤销/重做结果正确（四项分别单独验证）。

### 7.2 时序与性能

- [x] 框选拖动过程中不出现聚合工具条；松手后出现。
- [x] 拖动选中节点过程中工具条隐藏；拖停后在新位置重新出现（节点移动 171×117 flow px，拖动中工具条 `display:none`，松手后在新位置出现；撤销恢复原位）。
- [x] 平移/缩放画布时工具条跟随，尺寸不变；贴边时钳制，不闪烁（zoom 0.2 / 0.496 / 0.8 下卡片恒为 313×50；左钳制 x=8，右钳制 x=1229 = 1550−313−8；上方空间不足时落到下方 y=294；完全离开视口时隐藏。平移跟随通过视口 transform 变化验证，未用真实中键拖拽，原因见第 9 节）。
- [x] 普通多选时工具条位于可见外框上方 12px + 标题高度（28px × zoom），为编组后的组标题预留空间；选中的全是组时外框隐藏，工具条位于组并集上方 12px（zoom 0.42 实测间距 24px = 12 + 28×0.42；zoom 0.35 实测 21.8px；全组选区卡片底边 204、组并集顶边 216，间距恰为 12px，外框隐藏）。
- [x] 129 节点 Ctrl+A：只挂 1 条聚合工具条，per-node 工具条为 0；DOM 元素数量显著低于此前约 642 个的增量（当前画布 131 节点：1 条聚合工具条、0 条 per-node 工具条，DOM 增量 129，远低于约 642 的基线）。
- [x] 不出现新的选中/起拖长任务回归；必要时用 PerformanceObserver 对比基线（实测长任务 97–113ms，基线为 273ms + 109ms，无新增回归）。

### 7.3 交互与可访问性

- [x] 点击工具条按钮不会开始框选、拖动节点或平移画布（在计数区按下并拖动：无 `data-marquee-active`、节点位置不变、视口不变、选区保持）。
- [x] 工具条挂载不抢焦点；Tab 可依次到达编组/解组、创建副本、更多（挂载后 `document.activeElement` 为 BODY；DOM 顺序为 编组 → 创建副本 → 更多，三者 tabIndex 均为 0。原生 Tab 键遍历未自动化，见第 9 节）。
- [x] 菜单打开时第一次 Esc 只关闭菜单，不清空选区；再次 Esc 清空选区（第一次 Esc 关闭「更多」菜单并把焦点还给触发器，选区保持 2 节点；第二次 Esc 清空选区并卸载工具条）。
- [x] 图标按钮有可访问名称；计数有 `aria-live` 播报（按钮文字 + 「更多」`aria-label="更多操作"`；计数节点 `aria-live="polite"`，文案「2 个节点」）。
- [x] 明暗主题下按钮、边框、焦点环、悬停态对比度正常（按钮文字：深色 17.18:1 / 浅色 19.8:1；计数：深色 6.94:1 / 浅色 4.74:1；悬停文字：深色 15.79:1 / 浅色 18.97:1；焦点环沿用全局 `Button` 的 `ring-ring/50`，环色与卡片背景对比度深色 1.87:1 / 浅色 1.54:1，低于 WCAG 非文本 3:1，属全项目 Button 现状而非本次改动引入，见第 9 节观察项。真实主题切换被预览会话 401 阻断，明暗对比通过应用 colorMode 类实测）。

### 7.4 回归

- [x] 单选工具条内容与位置不变（`NodeToolbar.tsx` 的单选工具条未修改；组色板预览随 2026-11-11 组表面对齐增量调整，见当前状态；单视频节点实测 404×50、9 个按钮）。
- [x] 工具条、组节点工具条、节点类型标签与快捷键面板统一显示“编组”，不再出现旧叫法（`common.group`、`node.group`、`node.groupWithCount`、`shortcuts.group`、`shortcuts.desc.group` 均为“编组”；`director.group` 的“打组”属于导演模块的独立功能，不在画布术语范围）。
- [x] 批量连线右缘按钮不变，且不与聚合工具条重叠（`BatchConnectHandle.tsx` 未修改；实测批量轨道 28×28 @ (1069,370)，聚合工具条 313×50 @ (818,642)，无交集；拖拽会话规则见 `canvas-batch-connect-drag.md` 规则 1「起手」至规则 6「清理」）。
- [x] 编组/解组快捷键、Ctrl+D、Delete、右键菜单行为不变（`use-canvas-keyboard.ts` 未修改；右键菜单差异仅为创建副本图标 `PlusSquareOutlined` → `DuplicateIcon`，无行为变化）。
- [x] 框选提交后立即编组：框选外框与组 body 可见框四边对齐、尺寸一致（四边均 40px）；组标题保持在框外，仍可编辑、可拖动。
- [x] 现有 `canvas-derived`、`use-group-operations`、`group-layout`、`NodeToolbar` 测试通过（canvas 全量 100 文件 / 940 用例通过，含新增回归）。
- [x] `lint`、类型检查、`web` 测试串行执行通过（遵循仓库约定，不并行跑高内存检查；变更文件 ESLint 0 error，web `tsc --noEmit` 通过）。

## 8. 已确认决策（2026-11-02）

用户表示“都按你推荐的来”，并明确要求产品术语使用“编组”；以下为最终决策：

1. **范围**：本次只实现 Phase 1（聚合工具条 + 现有动作入口）；多选布局放入 Phase 2，另行确认后实现。
2. **计数文案**：使用“{{count}} 个节点”（英文“{{count}} nodes”），新增 i18n key；不用“已选 N 项”。
3. **创建副本位置**：保留在主行，与“编组/解组”同级；“更多”只承载低频动作。
4. **更多菜单**：Phase 1 只放“复制 / 删除”；下载延后，需独立 Spec。
5. **混合选择规则**：选中项含任意组节点时只显示“解组”，不显示“编组”，避免现有 `onGroupNodes` 静默过滤组节点导致误操作。
6. **组专属动作**：多选时不提供组颜色/组内布局入口；用户单击该组进入单选后使用组节点工具条。
7. **间距与钳制**：工具条与 `containerBbox` 间距 12px；普通多选锚定节点并集四边外扩 40px，顶部再加标题带 28px；选中的全是组时锚定组并集；可见性只看 `bbox` 与视口的交集（标题带与外框内边距单独相交不显示，见 4.1-5）；水平钳制时左右各留至少 8px。
8. **Phase 2 方向**：布局结果以选区包围盒中心为锚点整体平移；组节点作为原子盒子，组内相对坐标不变；智能布局只统计选区内部连线；大选区性能阈值在 Phase 2 Spec 中基于实测确定，不预先拍数字。
9. **术语**：产品文案统一使用“编组”，不再使用“分组”；`common.group`、`node.group`、`node.groupWithCount`、`shortcuts.group`、`shortcuts.desc.group` 一并更新，避免工具条、组节点与快捷键面板叫法不一致。
10. **统一边距**：编组、组内布局、框选外框统一为「标题带在 body 外 + body 四边 40px」；编组创建时组框向上多扩 28px，成员绝对位置不动；旧组执行一次组内布局后归一。该决策取代此前「顶部 12px、刻意不对称」的取舍。

## 9. 当前状态

- 状态：已实现（Phase 1；2026-11-03 用户确认）。Phase 2 设计与确认未开始，不在本次范围。
- 增量状态（2026-11-11/12）：组表面 CSS 已手工验证；`GroupConnectRail` 的拖线预览仅有状态机单测与 JS `PointerEvent` 现场验证，真实指针拖线未复现；批量连线主体规则实现完成，`canvas-batch-connect-drag.md` 规则 6「清理」第 5 条（组件卸载清理）已于 2026-11-12 修复并补回归用例；`BatchConnectHandle` 已于 2026-11-12 用 headless Chrome CDP 完成组件级现场走查（正常批量连线、拖拽中卸载取消、卸载后重拖，见 `canvas-batch-connect-drag.md` 验收 6）；代码未提交，整体未达到「已实现」条件。本增量依赖的 `canvas-batch-connect-drag.md` 仍为「待确认」；确认前该增量不构成本 Spec 的已实现范围。规则见 4.10.10「组表面与拖线态」与 `canvas-batch-connect-drag.md` 规则 1「起手」至规则 6「清理」。
- 已完成：现状与即梦对照调查；Phase 1 方案、按钮矩阵、边界与验收标准；第 8 节全部决策确认；术语统一为“编组”；统一边距决策确认。
- Phase 1 实现（2026-11-02 实现，2026-11-03 提交 `e6fc53ad`）：
  - `web/src/features/canvas/shared/canvas-derived.ts` 新增 `selectionChromeBounds`：全部选中节点（含组）的绝对包围盒、计数与是否含组，与 `selectionFrame` 并列且不改变其语义。
  - 新增 `web/src/features/canvas/controls/SelectionToolbar.tsx`：展示层负责按钮矩阵与「更多」菜单；容器层用 `Panel` 渲染在画布屏幕层，订阅视口做投影与钳制，`ResizeObserver` 实测工具条宽度。
  - `web/src/features/canvas/InfiniteCanvas.tsx` 在 ≥2 个选中节点、交互空闲且无编辑现场时渲染聚合工具条，并在多选时抑制 per-node 通用工具条；媒体编辑面板路径不变。
  - 新增 `canvas.selection.count` 中英文文案；`common.group`、`node.group`、`node.groupWithCount`、`shortcuts.group`、`shortcuts.desc.group` 的中文统一为“编组”。
  - 「更多」触发器不使用 `Tooltip`：Radix Tooltip 会在焦点回到触发器时打开并用 `preventDefault` 吞掉下一次 Esc，破坏「第一次 Esc 关菜单、第二次 Esc 清空选区」；改用 `title` + `aria-label`。
  - 根因修复（2026-11-02，用户反馈「现在看不到工具条」）：框选提交不派发交互动作，模式停留在 `box-selecting`，聚合工具条被 `showSelectionChrome` 门控掉。交互状态机新增稳定态 `box-selected` 与动作 `selection-commit`；`MarqueeSession.commit()` 在写入选区后派发 `selection-commit`；`use-canvas-interaction` 新增 `showSelectionToolbars = idle | box-selected` 供 per-node 与聚合工具条共用，`showSelectionChrome` 保持 idle-only 供生成面板使用；拖动节点时 `prev` 记录并恢复 `box-selected`。回归覆盖：`marquee-session.test.ts` 断言提交派发、`canvas-store.test.ts` 断言状态迁移、`use-canvas-interaction.test.ts` 断言两套可见性谓词。
  - 容器口径统一（2026-11-02，用户确认「按方案改」）：`selectionChromeBounds` 新增 `frameVisible` 与 `containerBbox`；`InfiniteCanvas` 用 `frameVisible` 控制 `.hide-selection-rect`，删除重复的选区扫描；聚合工具条改锚 `containerBbox`（普通多选 = 节点并集 + 40px，全组选区 = 组并集；可见框顶部 12px 与工具条标题让位见下两条）；多选外框圆角改为 `var(--radius)`（与组 body 的 `rounded-lg` 同源），持久外框填充对齐 `GROUP_COLORS.default.fill`（2026-11-11 已解耦为独立 token，见下条）。
  - 组可见框对齐（2026-11-02，用户确认「框选减去标题高度」）：组标题保留在 body 之外；框选外框改为顶部 12px（40 − `NODE_TITLE_HEIGHT` 28）、左右/底部 40px，`containerBbox` 顶部同步为 12px（工具条标题让位见下条）。框选提交后立即编组时两框可见边缘重合，标题不进入组的填充/描边/选中环；`GroupNode` 的 body 结构不变（`flex-1`）。（该口径已被 2026-11-02「统一边距」决策取代，见下条）
  - 工具条标题让位（2026-11-02，用户确认「顶部和工具栏之间加上一个标题的高度」）：可见框保持顶部 12px；`containerBbox` 顶部改为 40px（可见框 12 + `NODE_TITLE_HEIGHT` 28），工具条相对可见框的顶部间距为 12px + 28px×zoom，编组后组标题不与工具条重叠；左右/底部仍为 40px。（该口径已被 2026-11-02「统一边距」决策取代：可见框改为四边 40px，`containerBbox` 顶部 68px；工具条相对可见框的间距仍为 12px + 28px×zoom）
  - 主行动作图标（2026-11-02，用户反馈「编组的图标没显示出来，还有创建副本的图标也没有显示」）：编组 / 解组 / 创建副本按钮由纯文字改为图标 + 文字；编组用 `GroupIcon`、解组用 `UngroupIcon`、创建副本用 `DuplicateIcon`，全部从 `components/ui/AppIcon` 出口获取；图标 `aria-hidden`，按钮可访问名称仍由文字提供。
  - 创建副本图标统一（2026-11-02，用户提出「应该和右键菜单那个创建副本的图标一致」并确认采用 `DuplicateIcon`）：右键菜单的创建副本由 `PlusSquareOutlined`（方形加号）改为 `DuplicateIcon`（错位双层方框），与聚合工具条一致。选择 `DuplicateIcon` 的理由：双层方框是「复制 / 副本」的通用语义；方形加号更像「新建 / 添加」；右键菜单的「复制」已使用 `CopyOutlined`，两个动作需要保持图标区分。`PlusSquareOutlined` 在项目中仅此一处使用；2026-11-03 代码审查确认该导出已无调用方，连同 `LucideSquarePlus` 导入从 `AppIcon.tsx` 删除。
- 统一边距（2026-11-02，用户确认「编组之后，里面的内容距离四周应该和布局之后一样，包括框选的时候」）：编组创建改为 `groupY = minY - NODE_TITLE_HEIGHT - GROUP_NODE_PADDING`、`groupH = unionH + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING * 2`；框选外框改为 `padding: 40px; margin: -40px`；`containerBbox` 顶部 = 可见框 40 + 标题带 28 = 68px，高度 = `bbox.height + 108`；`GroupConnectRail` 的轨道中心下移 `NODE_TITLE_HEIGHT / 2` 对齐 body；布局 `group-layout.ts` 已是目标口径，不改。该口径取代此前「顶部 12px」的取舍。
- 已执行（2026-11-02，主行动作图标）：`SelectionToolbar.test.tsx` 16 用例通过（新增主行动作按钮均含 SVG 图标的回归用例）；右键菜单统一为 `DuplicateIcon` 后 `CanvasContextMenu.test.tsx` 3 用例通过；变更文件 ESLint 0 error；`tsc --noEmit`（server + web）通过。图标路径另行用 sharp 渲染 18px / 13px 两档确认可见（临时预览文件已删除），浏览器实机渲染仍待人工走查。
- 已执行（2026-11-02，组可见框对齐 + 工具条标题让位）：web 全量测试 192 文件 / 1553 用例通过（单 worker，串行，标题让位前基线）；本次改动后定向回归 `canvas-derived.test.ts` 7 用例、`SelectionToolbar.test.tsx` 15 用例通过；变更文件 ESLint 0 error；`tsc --noEmit`（server + web）通过。`GroupNode.test.tsx` 1 用例在前一版通过，本次未改动组节点结构；编组图标替换仅经 ESLint / tsc 检查，无图标路径单测。
- 已执行（2026-11-02，统一边距）：canvas 全量测试 100 文件 / 937 用例通过（单 worker，串行，含新增的编组创建几何用例）；定向回归 `canvas-derived` / `use-group-operations` / `SelectionToolbar` / `GroupNode` / `group-layout` / `group-bounds` 共 72 用例通过；变更文件 ESLint 0 error；web `tsc --noEmit` 通过。浏览器实机走查仍待完成。
- 已执行（2026-11-02，代码审查修复）：canvas 全量测试 100 文件 / 940 用例通过（单 worker，串行，较基线 937 新增 3 条回归）；变更文件 ESLint 0 error；web `tsc --noEmit` 通过。
- 人工走查（2026-11-03，dev 预览 `http://localhost:3000/canvas/mtxij9lscl5m0a`，131 节点 / 6 组）：7.1–7.4 共 28 项已逐项走查，证据见各勾选项内注记；走查期间未修改业务代码。工具条与可见框顶部标题让位、编组/布局/框选四边 40px、组连接轨道与 body 中心对齐、框选外框与编组 body 边缘对齐、主行动作图标实际渲染、明暗主题对比度、129/131 节点 Ctrl+A 的 DOM 规模与长任务回归均已覆盖。
  - 环境限制：预览会话 API 返回 401（`/api/files/upload-limits`），主题切换无法持久化（`savePreference` 乐观更新后回滚）；明暗对比通过给 `.react-flow` 应用 `light` / `dark` colorMode 类并同步 `<html>` 主题类实测，验证后已恢复深色。
  - 未覆盖：真实鼠标中键平移（合成事件会破坏 d3-zoom 内部 `__zoom` 状态；已改为通过视口 transform 变化验证跟随与钳制）；原生 Tab 键遍历（仅验证 DOM 顺序、tabIndex 与可聚焦性）。
  - 观察项：聚合工具条焦点环沿用全局 `Button` 的 `focus-visible:ring-ring/50`，实测环色与卡片背景对比度深色 1.87:1 / 浅色 1.54:1，低于 WCAG 非文本 3:1；该样式为全项目 Button 现状，非本次改动引入。如需提升，应单独调整全局设计令牌。
- 2026-11-03：用户指示将状态更新为「已实现」（Phase 1）；Phase 1 已提交为 `e6fc53ad`，审查修复为 `247d6515`，用户确认推送。
- 代码审查根因修复（2026-11-02，`/code-review` 未提交代码）：
  - refit 顶部扩张计入 `NODE_TITLE_HEIGHT`：成员探出组顶时组框上扩 `探出量 + 28 + 40`，修复 body 顶边距退化为 12px；`group-bounds.test.ts` 新增「只探出组顶」回归用例。
  - 聚合工具条展示层不再用 React key 重挂载：`selectionKey` 只作为「更多」菜单的 `key`，选区变化时菜单重挂载关闭，`aria-live` 计数节点保留；测试断言选区变化后计数 DOM 节点同一。
  - 工具条 `h-[50px]` + 单行不换行改为 `min-h-[50px]` + `flex-wrap`，容器按视口宽度设置 `maxWidth`；删除「视口窄时横向溢出」的已知边界。
  - 选区并集循环抽为 `unionBounds`；`multiSelect` 阈值抽为 `selectCanvasToolbarMode`，`InfiniteCanvas` 只消费模式结果。
  - 框选外框的 padding/填充改由 `RF_STYLE` 注入 `--group-node-padding` / `--selection-frame-bg`，与 `GROUP_NODE_PADDING`、`GROUP_COLORS.default.fill` 同源，删除 CSS/TS 双份字面量。（2026-11-11 组表面改为不透明后，填充改由 globals 独立 token 提供，见下条）
- 代码审查根因修复（2026-11-03，`/code-review` 已提交代码 `e6fc53ad`，修复已提交 `247d6515`）：
  - 统一组 body 顶部内缩：新增 `GROUP_BODY_TOP_INSET = NODE_TITLE_HEIGHT + GROUP_NODE_PADDING`，编组创建、refit 与组内布局共用；编组创建与组内布局再共用 `groupRectFromContent`，删除重复的「标题带 + 内边距」推导。
  - 聚合工具条可见性改按选区并集判定：`computeSelectionToolbarPlacement` 拆为 `visibleBounds`（`bbox`，交集判定）与 `anchorBounds`（`containerBbox`，定位），修复选区完全离开视口、但标题带或外框内边距仍与视口相交时工具条仍显示的问题。
  - 编辑态清单收敛到 `selectMediaEditorNodeId`：`canvas-edit-actions.ts` 以单函数返回八个面板的当前节点 id，`InfiniteCanvas` 改为单值订阅，删除重复的 `??` 链。
  - `SelectionToolbar` 用 `memo` 包裹，视口帧只重算定位，不重渲染按钮子树；删除无外部引用的常量与类型导出。
  - 删除已无调用方的 `PlusSquareOutlined` 图标导出及其 `LucideSquarePlus` 导入；修正 `idle ↔ box-selecting` 三处过时注释为 `box-selected`。
  - 回归：`canvas-derived.test.ts` 更新 `containerBbox` 断言；`SelectionToolbar.test.tsx` 改为 `anchorBounds` + `visibleBounds`，新增「仅锚点与视口相交时隐藏」与「定位取锚点、可见性取选区并集」两条用例。
- 已执行（2026-11-03，代码审查根因修复）：定向回归 3 文件 / 32 用例通过（`canvas-derived` 8、`SelectionToolbar` 19、`use-canvas-interaction` 5）；canvas 全量 100 文件 / 942 用例通过（单 worker，串行）；变更文件 ESLint 0 error；web `tsc --noEmit` 通过。浏览器实机走查未在本次修复后重跑。
- Phase 2 设计与确认未开始。
- 组表面视觉对齐即梦（2026-11-11，用户确认「按即梦对齐」）：组 body 由半透明 `GROUP_COLORS.fill` 改为不透明表面——默认组 `--canvas-group-bg`（暗 `#161616` / 亮 `#ededed`），彩色组 `color-mix(in srgb, tint 16%, var(--canvas-group-bg))`；`GROUP_COLORS` 移除 `fill`、新增可选 `tint`，新增 `getGroupSurfaceBackground`（`web/src/lib/constants.ts`），`GroupNode` 与颜色选择色板复用。组表面不透明后，持久多选外框填充不再从组填充派生，改由 `globals.css` 的 `--selection-frame-bg` 独立提供（保持旧值 4% 白），`CanvasSurface` 的 `RF_STYLE` 不再注入该变量；规则 4.10.7 同步更新。回归：`GroupNode.test.tsx` 补默认/彩色表面用例，新增 `group-surface.test.ts` 覆盖全部色板字面量、未知 key 与 globals.css 的 token 契约（组底色为不透明 6 位 hex、选择外框不复用组表面）；`NodeToolbar.test.tsx` 补色板预览用例（default 与蓝色均使用不透明组表面）。web 全量 219 文件 / 1758 用例通过（单 worker，串行），`tsc --noEmit` 与变更文件 ESLint 通过。现场验证（dev 目标，2026-11-11）：暗色组 body 计算 `rgb(22, 22, 22)`、亮色 `rgb(237, 237, 237)`，均 `opacity: 1`；`color-mix` 蓝/黄色探针在暗亮两主题下均解析为不透明 `color(srgb …)`；`--selection-frame-bg` 解析为 `#ffffff0a`（4% 白）。组颜色选择器现场打开验证：弹层 10 个色板，default 计算 `rgb(22, 22, 22)`，蓝色 `color(srgb 0.0862745 0.147137 0.232471)`（≈`rgb(22, 38, 59)`），均不透明；验证后关闭弹层、清除选中（选中数回到 0）。未覆盖：当前画布无彩色组，彩色组 body 仅由单测断言内联表达式、浏览器侧用同表达式探针验证解析；明暗切换采用 colorMode + `<html>` 类同步模拟（与既有验证口径一致）；验证时缩放约 0.26（18 × 0.26 < 8），点阵按 LOD 未挂载（点阵规则见 `canvas-dot-grid.md`），点阵被组表面遮挡的最终视觉与真实多选外框均未现场观察（仅由不透明计算样式与层叠关系推断）。
- 组表面拖线预览对齐即梦（2026-11-12，用户确认「一起对齐」）：`GroupNode` 的 body 不再内联 `background`，改为写入 `--group-surface`；正常态背景由 `.node-body.canvas-group-surface` 读取该变量，`.react-flow[data-connecting]` 期间改为 `color-mix(in srgb, var(--group-surface) 20%, transparent)`。只降低背景不透明度，标题与描边保持不透明，对齐即梦 `.is-connecting ... opacity-canvas-group-connection-preview`（`opacity: .2`）；规则见 4.10.10「组表面与拖线态」。回归：`GroupNode.test.tsx` 断言 `canvas-group-surface` 类、`--group-surface` 取值与无内联 background；`group-surface.test.ts` 新增 CSS 契约（正常态读变量、拖线态 20%、不使用元素 opacity）。定向 2 文件 / 9 用例、`tsc --noEmit`、变更文件 ESLint 通过。现场验证（dev 目标，2026-11-12）：手动给 `.react-flow` 加 `data-connecting` 后，暗色组 body 背景由 `rgb(22, 22, 22)` 变为 `color(srgb 0.0862745 0.0862745 0.0862745 / 0.2)`（同色 20% alpha），描边颜色不变、body/组 `opacity` 均为 1；亮色由 `rgb(237, 237, 237)` 变为 `color(srgb 0.929412 0.929412 0.929412 / 0.2)`；彩色探针 `color(srgb 0.0862745 0.147137 0.232471)` 在拖线态变为同色 `/ 0.2`；移除属性后恢复。验证期间 dev 页面因全局 CSS HMR 重载，已恢复原视口并确认 133 节点 / 66 边数据完整。真实指针拖线未能在后台标签页复现（`visibilityState=hidden`，CDP 受信鼠标事件未启动连接）；`data-connecting` 由交互状态机写入，已有 `use-canvas-interaction` 单测覆盖。审查根因修复（2026-11-12）：批量连接轨道（`GroupConnectRail` / `BatchConnectHandle`）原在 pointerdown 即调用 `onDragStart`，右键/中键或未越过 4px 的单击也会进入 connecting，使全部组表面短暂降到 20%；修复后的会话规则统一由 `canvas-batch-connect-drag.md` 规则 1「起手」至规则 6「清理」定义，本条目只保留修复与验证结论。回归：`use-batch-connect-drag.test.ts` 扩至 15 用例，新增右键/非主指针不拦截默认行为、阈值前 pointercancel、4px 边界只进入一次、其他指针不驱动/终止、非左键 pointerup 取消、左键松开取消、远距离 pointerup 补判等断言；定向 1 文件 / 15 用例、`tsc --noEmit` 与变更文件 ESLint 通过，web 全量 219 文件 / 1767 用例通过（单 worker，串行）。现场验证（dev 目标，2026-11-12，向组连接轨道派发 JS `PointerEvent` 驱动真实 React 处理器）：主键 pointerdown 后 `data-connecting` 不存在、组背景保持 `rgb(22, 22, 22)`；位移 2px 仍不进入；位移 8px 后 `data-connecting=true`、组背景变为同色 `/ 0.2`；其他指针的 cancel/move/up 不改变 connecting；左键松开（buttons 只剩右键位）与右键 pointerup 均取消并恢复背景；结束时 133 节点 / 66 边不变、无菜单。

## 10. 后续阶段（不在本次范围）

### 10.1 Phase 2：多选布局

目标：在聚合工具条中增加“布局 ▾”，提供智能 / 宫格 / 水平 / 垂直四种模式，作用于当前选中的顶层项。

设计方向（Phase 2 另行确认）：

1. 从 `shared/group-layout.ts` 与 `shared/layered-layout.ts` 抽出可复用的布局核心；选区布局与组内布局共享排序、分层、间距与盒模型，但坐标空间不同。
2. 组节点作为整体盒子移动；组内成员不单独参与布局；组内相对坐标保持不变。
3. 智能布局只统计“两端都在选中集内”的连线；指向选区外的边不参与分层。
4. 布局结果以选区包围盒中心为锚点整体平移；一次布局一条历史记录。
5. 大选区需要性能上限或异步/动画策略，不能对上百节点同步跑 dagre；具体阈值在 Phase 2 Spec 中基于实测确定。
6. 多选布局不修改组框内部布局；组内布局仍走组节点工具条。

### 10.2 其他候选

- 批量下载：需要单独定义混合媒体、打包格式、命名冲突、失败重试与浏览器权限。
- 对齐 / 分布：需要新增几何规则与快捷键，不与“布局”混为同一动作。
- 堆叠：在确认即梦语义与本仓库产品需求前不实现。

# Canvas Undo Redo Integrity

状态：已确认

决策记录：2026-10-11 链路审查确认六项缺陷（见背景）。同日用户确认三项关键决策：撤销/重做**不恢复视口**；媒体编辑面板打开时对画布级撤销/重做**统一拦截**；生成中右键菜单撤销/重做**置灰禁用**。同日用户报告第七项缺陷（replace 上传回填缺 skipHistory，撤销回到进度条僵尸态），根因已确证并补入背景与业务规则 7；原规则 4 中「上传替换回填按离散压栈」的结论系当时推测、已被推翻，相应移除。同日用户确认 Spec 整体，开始实施。实施完成后用户实测发现 replace 语义缺口（空节点上传/更换图片后撤销直接删节点，上传动作无独立撤销步），确认为规则 7 的最终口径：压栈时机前移至上传瞬态写入之前（见规则 7 历史注记），已按此实施。

## 目标

修复画布撤销/重做链路的六项缺陷，使撤销栈满足：时间序严格单调、撤销粒度可预期、恢复后的画布状态与 store 一致、生成 / Agent / 媒体编辑面板等子系统与撤销的交互有唯一口径。

## 背景（调查结论）

审查范围：history-store、canvas-store（压栈/节流/快照）、canvas-edit-actions（恢复/编辑动作）、use-canvas-keyboard、InfiniteCanvas（拖拽/连线）、ResizeHandle、use-tidy-animation、use-group-operations、use-generation-submit + 三生成面板、use-sse-task-monitor、agent 流（use-canvas-agent-stream / executors / user-action-tracker）、use-canvas-session + save-manager、TextNode（Tiptap 同步）、ref-order。

1. **恢复视口未同步 React Flow**：`restoreSnapshot` 调 `setViewport`（canvas-edit-actions.ts:473）只写 store 与 `_liveViewport`；React Flow 视口仅在挂载与 `viewportSyncCount` 变化时同步（InfiniteCanvas.tsx:237），后者仅由 `restoreFromProject` 递增。撤销后 `_liveViewport` 与屏幕实际视口脱节：后续编辑把旧视口落库（保存/刷新后视口错位）、`getViewportCenter()`（资产插入、agent 建节点锚点）算错。
2. **Agent 回合快照回合末入栈破坏时间序**：回合模型为「首个工具轮拍快照、回合末 push」（use-canvas-agent-stream.ts:286-299）。回合进行中用户编辑画布是受支持流程（续轮重发 `userActions`、确认弹窗等待窗口），用户编辑先压栈、回合末更旧的快照压到栈顶——一次撤销吞掉用户中途编辑，再按一次出现「时间倒流后前进」的乱序恢复。
3. **方向键微调不入历史**：`nudgeSelectedNodes` 走 `setNodes`（永不压栈），与鼠标拖拽（dragStart 压栈）不一致；微调后 Ctrl+Z 回退的是上一个历史动作（节点可能直接消失）。
4. **300ms 节流跨操作类型共享**：`_lastHistoryTime` 全局共享于 setEdges/addNodes/updateNodeData/removeNodes/removeEdges（canvas-store.ts:90）。离散操作（删除/粘贴/连线/改名）落在上次压栈 300ms 内时不产生历史条目，Ctrl+Z 一次回退「上次编辑 + 本次操作」；撤销粒度随时序漂移。`deleteSelection` 恰好依赖该节流把删节点+删边并成一步，属脆弱耦合。
5. **生成失败不清预生成快照**：用户取消路径经 `dropPendingHistory`/`popIfTop` 正确回滚；SSE 终态失败（use-sse-task-monitor.ts:155）只清 taskBinding，预生成快照留栈顶——失败后第一次撤销是视觉无变化的无效步。
6. **菜单撤销缺守卫**：CanvasContextMenu 仅按 `canUndo/canRedo` 禁用（CanvasContextMenu.tsx:179）。生成中点撤销静默无效（键盘路径有提示）；媒体编辑面板打开时经菜单撤销，`restoreSnapshot` 只处理 `editingTextNodeId` 悬空，其余编辑态宿主消失后面板悬空。
7. **replace 上传回填缺 skipHistory（2026-10-11 用户报告，根因已确证）**：节点上传/替换内容（`useNodeUpload`，Image/Video/Audio 共用 replace-node sink）成功回填走 `runSuppressed(updateNodeVisual(...))`（upload-pipeline.ts replace 路径）——`runSuppressed` 只抑制 Agent 动作感知，不抑制撤销历史，且未传 `skipHistory` → 把「上传中」瞬态快照压进撤销栈。Ctrl+Z 恢复出僵尸进度条态（上传已结束、进度条目已清、无重试入口）。新建节点路径不受影响（applyUploadResult 已带 skipHistory）。该误压栈受节流影响时有时无；未误压时用户也需两次撤销才能回到上传前内容。

已确认无恙（回归保护对象）：popIfTop 引用比对补偿回滚、生成提交 owner fencing 与栈深校验、上传/生成回填与 refOrder 写入 skipHistory、Tiptap 外部变更同步、删节点联动清编辑态、整理动画先取消再恢复、快照结构化共享（未发现原地突变）、HISTORY_MAX_SIZE=50 截断、项目采纳时 clear 历史与断线重连同租约不清历史。

## 范围

- 改动：
  - `web/src/features/canvas/stores/canvas-store.ts`（压栈通道二分 + 同步批量守卫 `withHistoryBatch`）
  - `web/src/features/canvas/shared/canvas-edit-actions.ts`（restoreSnapshot、nudge、deleteSelection、pasteNodes、统一守卫）
  - `web/src/features/canvas/controls/CanvasContextMenu.tsx`（置灰与 Tooltip 提示）
  - `web/src/features/canvas/agent/hooks/use-canvas-agent-stream.ts`（回合快照即时压栈）
  - `web/src/features/canvas/panels/use-generation-submit.ts` + Image/Video/Text 三面板（预生成快照注册表收口，面板直调注册表函数）
  - `web/src/features/canvas/hooks/use-sse-task-monitor.ts`（失败/取消终态弹快照）
  - `web/src/features/canvas/hooks/use-editable-title.ts`、`nodes/NodeToolbar.tsx`（GroupColorPicker）——离散压栈；`upload/upload-pipeline.ts`（replace 压栈时机前移 + 占位创建批量）、`upload/derived-node.ts`（派生批量 + `CanvasStoreApi` 复用 `HistoryPushOptions`）
  - 规则 4 向全部调用点的落地（同一原子操作合并/离散必入栈）：`InfiniteCanvas.tsx`（建节点+归组+接线、batchConnect、资产拖放）、`nodes/VideoNode.tsx`（分离音频/片段截取/画面裁剪）、`controls/DeletableEdge.tsx`、`shared/AudioRefCard|ImageRefCard|VideoRefCard|TextRefChip`（断开参考）、`explorer/CanvasExplorer.tsx` 与 `features/assets/components/AssetsDialog.tsx`（资产插入）、`hooks/use-add-node.ts`
  - `agent/components/AgentDrawer.tsx`（回合撤销入口走统一守卫）
  - 相关单测
- 不改动：`history-store.ts` 结构（双栈 / version / popIfTop 语义不变）；保存格式与 `CanvasData` 契约（viewport 仍保存）；服务端；拖拽 / 缩放 / 编组 / 解组 / 组内布局 / 整理的既有直连压栈方式；`minimapVisible`/`snapToGrid` 随快照恢复的现状语义；GEN-02 任务生命周期语义（弹快照不取消任务）。

## 业务规则

1. **撤销/重做不恢复视口**（已确认）：`restoreSnapshot` 移除 `setViewport` 调用，只恢复 nodes/edges/minimapVisible/snapToGrid；store `viewport` 与 `_liveViewport` 在撤销/重做前后保持用户当前视角。`takeCanvasSnapshot` 保留 viewport 字段（save-manager 保存链路复用同一函数）。随之根除：撤销后编辑把旧视口落库、保存视口与所见不一致、`getViewportCenter` 锚点错位。
2. **Agent 回合快照即时压栈**：回合首次要执行画布工具时拍快照并立即 push（废止「回合末统一入栈」）；回合收尾（正常结束 / 出错 / 停止 / 世代失效）时若本回合未产生任何画布变更则 `popIfTop` 补偿弹出。用户中途编辑的快照自然压在回合快照之上，栈内时间序严格单调；「撤销此轮」按钮 version 门控判定不变（压栈时记录 version），一次撤销整回合且不再吞并用户中途编辑。
3. **方向键微调入栈**：`nudgeSelectedNodes` 写位置前经节流压栈通道——首个微调压栈，300ms 窗口内连续微调合并为一条，可撤销一次回退整段微调。
4. **离散操作必定压栈 + 原子批量合并**：压栈通道二分——
   - 离散操作（创建/删除/粘贴/连线/标题改名/组配色）**必定压栈**，不受 300ms 节流（现有 `forceHistory` 语义并入此通道）；
   - 连续写入（打字、方向键微调）保持节流合并；
   - 同一原子操作内的多步写入合并为一条：新增**同步批量守卫**（模块级计数，批量期间仅首次压栈生效）。`deleteSelection`（removeNodes+removeEdges）、`pasteNodes`（addNodes+setEdges）以批量包裹，一次 Ctrl+Z 精确回退一步。
   - 批量守卫是同步语义（同一 JS 任务内 begin/end），异步间隙的独立操作不并吞。
5. **预生成快照生命周期收口**：提交成功写入绑定后，预生成快照按 taskId 登记模块级注册表（收编面板内 `pushedSnapshotRef`）；任务到达**失败/取消终态**时 `popIfTop` 弹出，**成功终态**保留（撤销一次 = 移除生成结果）；项目采纳清历史时注册表一并清空。快照非栈顶时放弃弹出（沿用引用比对），栈序仍单调。弹快照不取消任务（GEN-02 语义不变）。
6. **入口守卫统一 + 编辑态悬空清理**（已确认统一拦截 / 置灰）：画布级撤销/重做守卫收口为单一函数（无生成中节点 && 无媒体编辑面板打开），键盘、右键菜单、AgentDrawer「撤销此轮」全部走它；菜单项在守卫不通过时置灰，悬停提示复用 `shortcuts.undoBlocked` 文案；`restoreSnapshot` 将 `NODE_UI_STATE_KEYS` 全量做悬空清理（宿主节点不在快照中 → 置 null），泛化现有 `editingTextNodeId` 检查（统一拦截下正常不可达，防御性保留）。
7. **replace 上传的撤销语义（2026-10-11 用户报告两轮，最终口径）**：上传/更换节点内容（`useNodeUpload`，Image/Video/Audio 共用 replace-node sink）是离散用户操作，必须有独立撤销步——
   - replace 分支在写入上传瞬态「**之前**」压入「替换前」快照（此刻节点仍是旧内容/空态，未被瞬态污染）；瞬态写入与成功回填一律 `skipHistory`（僵尸进度条态永不入栈）；失败回滚后 `popIfTop` 弹出补偿（回滚已还原替换前内容，快照成冗余步）。
   - 撤销链（空节点 → 上传 → 更换图片）：撤销① 回到第一张图；撤销② 回到空节点；撤销③ 节点消失。空节点 → 上传 → 撤销① 回到空节点（节点保留）。
   - `runSuppressed` 只抑制 Agent 动作感知、不抑制撤销历史，二者不得混用。
   - 拖拽直建节点（create-node sink）与派生节点（derived-node sink）不适用本条：建节点与上传是同一用户动作，`addNodes` 的一次压栈即整步撤销（撤销 = 节点整体消失），语义保持。
   - 历史注记：初版修复曾把 replace 回填改为全 skipHistory（压栈时机后移），导致「上传/更换内容」整体失去独立撤销步（撤销直接跳到创建前、节点消失）——用户实测发现后改为「压栈时机前移至瞬态写入之前」的最终口径。

## 技术影响

- `HistorySnapshot` 类型不变（viewport 字段保留、恢复侧忽略）；`save-manager` 无改动，undo 保存延迟（`SAVE_DELAY_UNDO`）不变。
- Agent 执行器全部 `skipHistory` 的现状不变；`user-action-tracker` 的 suppress / agentActing 语义不受压栈时机影响。
- 现有依赖节流合并行为的单测（canvas-store.test、use-sse-task-monitor.test GEN 语义锁定组等）按新口径调整，GEN-02 锁定用例必须继续通过。

## 异常与边界

- Agent 回合无变更且用户已在中途编辑：`popIfTop` 失败，回合快照残留为一条内容重复的无效步（多按一次撤销）——已知小代价，接受。
- 生成期间用户编辑导致预生成快照非栈顶：失败终态放弃弹出，撤销多一步但时间序正确。
- 撤销会一并回退 `minimapVisible`/`snapToGrid`（现状语义保留）；如后续要改为环境设置不随快照恢复，另立需求。
- 项目切换 / 编辑权过期：clear 历史 + 注册表清空，撤销不可穿透到上一项目（现状已正确，回归保护）。

## 验收标准

1. 撤销/重做后 React Flow 实际视口与 `_liveViewport` 均不变；撤销后直接编辑，落库 viewport 与所见一致；资产插入 / agent 建节点锚点正确。
2. Agent 回合执行期间用户编辑画布：回合结束后撤销栈序单调（先撤用户编辑、再整撤回合）；「撤销此轮」在回合有变更且历史版本未变时可用并一次撤销整回合；回合中途用户编辑会使版本号增长，「撤销此轮」随之置灰（该按钮本会误弹用户快照，置灰是正确口径）；无变更回合不占撤销步。
3. 方向键微调一次 Ctrl+Z 整段回退；微调后撤销不再出现节点消失 / 文字被清的错位回退。
4. 删除（节点+边）、粘贴（节点+边）、连线各自一次 Ctrl+Z 精确回退；在上一次压栈 300ms 内执行仍有独立撤销步。
5. 生成失败 / 取消后第一次 Ctrl+Z 直接回退上一个真实操作；生成成功后第一次撤销移除生成结果。
6. 生成中右键菜单撤销/重做置灰、悬停显示原因提示且光标为禁止（禁用项不接收指针事件，提示与光标由可接收悬停的包裹层承载）；媒体编辑面板打开时所有画布级撤销入口不可用；快照恢复后无悬空编辑面板。
7. 节点上上传/更换图片或视频后，一次 Ctrl+Z 回到替换前内容且节点保留（空节点场景回到空节点），不出现上传进度条瞬态；连续「上传 → 更换图片」的撤销链逐级回退（第一张图 → 空节点 → 节点消失）；拖到空白处新建节点的上传，一次 Ctrl+Z 删除该节点（回归保护）。
8. 全量 server/web 测试、typecheck、lint 通过（高内存 Node 任务串行执行）；新增单测覆盖：restoreSnapshot 不写视口、回合压栈时序与无变更补偿、nudge 合并、deleteSelection 单条、离散操作在节流窗口内仍独立入栈、replace 上传回填不压栈、失败终态弹快照、统一守卫。

## 待确认事项

- Spec 整体确认（三项关键决策已于 2026-10-11 经用户选择确认并回写决策记录）。

## 当前状态

- 已实施并通过验证（2026-10-11）：七项业务规则全部落地（视口不恢复、Agent 回合即时压栈 + 无变更补偿、微调入栈、离散必定压栈 + 同步批量守卫 `withHistoryBatch`、预生成快照注册表、统一守卫 + 悬空清理、replace 上传压栈时机前移 + 瞬态/回填 skipHistory + 失败补偿弹出）。代码审查（双轴）后完成整改：批量守卫 try/finally 收口为 `withHistoryBatch` 单一入口、移除 `dropPendingHistory` 转发层（面板直调注册表）、`CanvasStoreApi` 复用 `HistoryPushOptions`、菜单置灰项悬停提示改 Tooltip 包裹层触发（禁用项 `pointer-events-none` 使原生 title 失效）、补齐 Agent 回合压栈时序/无变更补偿与 SSE→注册表接线单测。web 全量 884 用例中仅剩两个既有无关文件（HoverCard / AudioWaveform）在单 fork 全量模式下偶发污染抖动、单跑均过（与 poster spec 记录的既有现象一致）；typecheck、lint 零错误。撤销/重做交互的浏览器端到端验证未执行（画布页有登录与会话门禁，环境内无凭据），交互层面待人工验证。

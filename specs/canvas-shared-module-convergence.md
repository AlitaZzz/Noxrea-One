# Canvas Shared Module Convergence

状态：已确认

背景：2026-10-30 审查指出两处缺口。其一，a0f5d055（组归属判定收敛）与 93df74b0（生成面板上游引用抽出共享模块并按值订阅）都重划了 canvas 共享模块边界，但 `specs/` 没有对应记录。其二，93df74b0 的订阅机制与已批准的《画布拖动性能根因修复》计划不同——计划写的是 `useShallow` 订阅派生切片，实际实现为 `useStoreWithEqualityFn` + `shared/upstream-refs` 按值比较。两笔改动的确认来源：组归属收敛由用户明确要求「从根因修复」；订阅收敛来自已批准计划中的「生成面板整数组订阅收敛」。实现均已合入 main 并推送，本 Spec 为事后补齐，记录实际口径；同时收口本次审查修复：业务 hook 位置迁移、媒体去重状态打包、比较循环收敛、`parentId` 直读收敛到 `memberParentId`。

## 目标

- 组归属判定全库唯一口径：任何调用方不自行组合 type / parentId 判断。
- 生成面板上游引用按内容订阅：拖动、整理动画等位置变化不触发面板重渲染，且不依赖全局缓存伪造引用稳定。
- 带业务语义的 hook 归属 `features/canvas/hooks/`。

## 范围

- 改动：
  - `web/src/features/canvas/shared/group-membership.ts` 归属原语；`shared/group-bounds.ts` 只保留组框几何；store、拖拽、连线、整理布局等全部调用方改经原语（a0f5d055）。
  - `web/src/features/canvas/shared/upstream-refs.ts` 纯投影 + `sameUpstreamRefs`；`hooks/use-node-upstream-refs.ts`、`hooks/use-node-generating.ts`；三生成面板按内容与布尔原语订阅（93df74b0）。
  - 三面板相关 hook 迁入 `features/canvas/hooks/`（含既有 `use-video-gen-panel.ts`，原在 `panels/`）。
  - `drag-snap.ts`、`agent/tools/executors.ts`、`InfiniteCanvas.tsx` 中读取归属父的 `parentId` 直读改经 `memberParentId`。
- 不改动：store 契约与节点数据结构；组框几何、整理布局与空组删除规则；生成面板 UI、交互与排序规则；持久化数据。

## 业务规则

1. **归属原语唯一**：`isGroupNode` / `memberParentId` / `isGroupMember` / `groupMembers` / `pruneEmptyGroups` 是成员判定的唯一实现。调用方读取「归属父」一律经 `memberParentId`，不得直接读 `parentId` 做归属判断；组节点不可能是成员（`memberParentId` 对组节点返回 undefined）。
2. **上游引用投影是纯函数**：输入只有入边与上游节点的类型、数据；节点位置不参与结果。图片按节点数组顺序，文本与媒体按连线顺序；文本按节点 id 去重，媒体按节点 id 与 src 双重去重；空文本与空 src 不进入结果。
3. **按值订阅**：`useNodeUpstreamRefs` 以 `sameUpstreamRefs` 作为 zustand equalityFn，内容不变即复用上次结果；不设全局缓存或字符串键。
4. **生成中状态是布尔原语**：`useNodeGenerating` 只订阅该节点的 taskBinding 派生布尔值；节点不存在按未生成处理。
5. **hook 位置**：带业务语义的 hook 位于 `features/canvas/hooks/`（web/AGENTS.md 八.1）。

## 技术影响

- 涉及模块：canvas 的 `shared`、`hooks`、`panels`、`drag`、`agent` 与 store 调用方。
- 无接口契约、数据结构与持久化变更；不改变生成面板的可见行为。
- 订阅选择器在每次 store 变更时重算投影（O(上游节点数)），以结构比较 bail；面板渲染次数只由内容变化决定。

## 异常与边界

- 节点不存在：`useNodeGenerating` 返回 false，`useNodeUpstreamRefs` 返回空引用集合。
- 组节点：不参与成员判定与命中测试；组节点自身不接收归属父。
- 同一上游节点多条入边：按首次出现的连线顺序保留一条（文本按 id，媒体按 id 与 src）。
- 投影结果只反映当前 store 快照，不持有节点引用，避免外部改写造成比较失真。

## 验收标准

1. `group-membership` 原语测试与 `upstream-refs` 投影、按值比较测试通过。
2. 按值比较测试证明仅位置变化的节点帧得到相等结果，数据编辑得到不等结果。
3. `web` 类型检查与 canvas 测试通过。
4. 归属判定与归属父读取一律经 `memberParentId`；`parentId` 直读仅用于结构性校验（`canvas-edit-actions` 载入校验与粘贴映射）、克隆重置（`node-defaults`）、缓存键（`canvas-derived.outlineKey`）与资产目录（`CanvasExplorer`，非画布节点）。

## 待确认事项

无。2026-10-30 用户确认：

1. 认可订阅机制以 `useStoreWithEqualityFn` + `sameUpstreamRefs` 取代已批准计划中的 `useShallow` 订阅派生切片。
2. 认可 `use-video-gen-panel.ts` 随本次一并迁入 `features/canvas/hooks/`（原在 `panels/`）。
3. 认可本 Spec 为事后记录：现转「已确认」，代码提交获批且验收通过后转「已实现」。

## 当前状态

- 2026-10-30：用户确认两项待确认事项，状态转「已确认」。a0f5d055、93df74b0 已合入 main 并推送；hook 迁移、媒体去重状态打包、比较循环收敛、`parentId` 直读收敛与本文档在工作区，未提交。验证：`tsc --noEmit`、改动文件 ESLint、canvas 测试 71 文件 / 666 用例均通过。代码提交获批后按验收标准复核并转「已实现」。

# 画布点阵与底色（Canvas Dot Grid）

状态：待确认（2026-11-11 用户要求与即梦对齐，实现完成、代码未提交；待用户确认本 Spec 与视觉走查）

## 目标

1. 点阵间距、点径、低缩放 LOD 与配色对齐即梦 `canvas-dot-grid`。
2. 点径保持 1 屏幕像素，不随缩放变化；低缩放时隐藏整层，画布回到纯色。
3. 画布底色由主题 token 统一提供，避免 React Flow 暗色主题的默认底色盖住应用背景。

## 范围

包含：

- `web/src/features/canvas/controls/CanvasDotGrid.tsx`。
- `web/src/features/canvas/root/CanvasSurface.tsx` 的 `--xy-background-color` 注入。
- `web/src/styles/globals.css` 的 `--canvas-bg` / `--canvas-dot-color`。

不包含：

- MiniMap、视口裁剪（`canvas-media-resolution-lod.md` 的非目标继续有效）。
- 节点内容的图片分辨率 LOD（见 `canvas-media-resolution-lod.md`）。
- 即梦暗色的逐点透明度抖动：React Flow 的 pattern 每格只有一个圆点，无法表达
  逐点差异，保留该已知差异。
- 组表面本身的视觉（透明度、配色、描边）、选择外框与连线视觉（分别见
  `canvas-multi-selection-toolbar.md` 规则 4.10.10「组表面与拖线态」、规则
  4.10.7「选区外框与组节点视觉对齐」、`canvas-flow-layer.md` 规则 8「颜色」及
  `web/AGENTS.md` §九.3「画布连线视觉约定」）。

## 业务规则

1. 间距：18 世界像素。
2. 点径：1 屏幕像素直径；React Flow `Background` 的 `size` 按 `1 / zoom` 换算成
   世界坐标，缩放时保持屏幕尺寸。
3. LOD：`18 × zoom < 8`（zoom 约 < 44.4%）时整层卸载，不绘制点阵；`>= 8` 时绘制。
4. 颜色：
   - 暗色：`--canvas-bg: #0d0d0d`，`--canvas-dot-color: rgb(255 255 255 / 20%)`。
   - 亮色：`--canvas-bg: #f5f5f5`，`--canvas-dot-color: rgb(115 115 115 / 45%)`。
5. 画布底色：`.react-flow` 的 `--xy-background-color` 读取 `--canvas-bg`；点阵卸载
   后仍保持该底色。
6. 组表面上的点阵可见性：常态下点阵被不透明组表面遮挡；拖线态下点阵可见，属
   预期视觉。组表面的透明度规则与取值由 `canvas-multi-selection-toolbar.md`
   规则 4.10.10「组表面与拖线态」定义。
7. 点阵是纯视觉背景，不表示吸附网格；吸附步长 `DEFAULT_SNAP_GRID_SIZE = 20` 与
   点阵间距 18 不同源，两者不要求对齐。

参数证据：18px 间距与 8px 屏幕阈值与即梦吸附代码中的 `18 × zoom ≥ 8` 门槛同值
（`canvas-snap-alignment.md:42`），但该旁证来自吸附逻辑，不能证明点阵渲染参数；
1px 点径与明暗色值为实现时目测对齐，未保留提取记录。以上参数均按未确认假设处理。

## 技术影响

- 新增 `web/src/features/canvas/controls/CanvasDotGrid.tsx`（`memo`，订阅
  `transform[2]`）。
- `web/src/features/canvas/root/CanvasSurface.tsx`：用 `<CanvasDotGrid />` 替换原
  `<Background variant={Dots} gap={20} size={1.5} color="var(--input)" />`，并在
  `RF_STYLE` 注入 `--xy-background-color: var(--canvas-bg)`。
- `web/src/styles/globals.css`：新增 `--canvas-bg` / `--canvas-dot-color`，明暗两套。
- 测试：`web/src/__tests__/features/canvas/controls/CanvasDotGrid.test.tsx`（4 用例）。

## 异常与边界

1. 缩放跨过 LOD 阈值的浮点边界：以 `18 × zoom < 8` 为准；测试覆盖 0.44 / 0.45。
2. 视口尺寸为 0：React Flow 仍会挂载 `Background`（0×0 SVG，无可见输出）；无额外
   处理。
3. 主题切换：颜色来自 CSS 变量，随 `.dark` 切换；组件不读取主题，无需重挂载。
4. 与既有 Spec 的关系：`canvas-media-resolution-lod.md` 的非目标已将背景点阵移交
   本 Spec（现行文本见该 Spec 第 87 行）；该 Spec 的图片 LOD 规则不受影响。
5. 与 MiniMap、视口裁剪无关。

## 验收标准

1. 几何（已验证）：zoom 0.5 时间距 9px、点半径 0.5px；zoom 2 时间距 36px、点半径
   0.5px。
2. LOD（已验证）：zoom 0.44 不渲染 `.react-flow__background`；0.45 渲染。
3. 颜色契约（人工核对，未被自动化测试锁定）：组件向 `Background` 传
   `color="var(--canvas-dot-color)"`；`globals.css` 明暗两套 token 见业务规则 4；
   `--xy-background-color` 读取 `--canvas-bg`。测试只断言 `color` prop 透传，
   token 与 `RF_STYLE` 注入需人工复核。
4. 实机视觉（未验证，待用户走查）：明暗两套主题、低缩放整层卸载、组表面遮挡下的
   最终视觉。
5. 回归（已验证）：web 全量 219 文件 / 1767 用例、`tsc --noEmit`、`npm run lint`
   通过（2026-11-12 记录）。

## 待确认事项

1. 是否确认 18px 间距、1px 点径、8px 屏幕间距阈值与明暗两套色值作为长期契约。
   其中 1px 点径与色值目前只有目测对齐依据，未保留即梦提取记录。
2. 即梦暗色的逐点透明度抖动是否需要在未来自绘点阵中补齐。

## 当前状态

- 状态：待确认；实现与单测已完成，代码未提交（2026-11-11/12）。
- 验证：`CanvasDotGrid.test.tsx` 4 用例通过；全量 web 219 文件 / 1767 用例、
  `tsc --noEmit`、`npm run lint` 通过。实机明暗主题与低缩放视觉未走查（预览 CDP
  不可用；缩放约 0.26 时点阵按 LOD 未挂载）。
- 已知缺口：颜色/CSS 契约未被自动化测试锁定；1px 点径与色值只有目测依据，见
  「业务规则」参数证据与「待确认事项」第 1 条。
- 来源：`canvas-multi-selection-toolbar.md` 2026-11-11 组表面条目与点阵旁注；用户
  要求「点阵也对齐」。

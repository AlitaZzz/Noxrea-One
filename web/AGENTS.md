<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
# 前端架构与实现规范

> 本文件是《项目协作规则》的前端部分，章节编号沿用规则原文档。总体协作规则见仓库根目录 `../AGENTS.md`。

## 七、消息通知规范

### 1. 场景分工

根据消息类型选择对应通知方式：

- 用户当前操作的即时反馈（复制、保存、上传等）使用轻量级消息提示。
- 异步任务结果、后台处理结果以及需要展示详细信息的错误使用通知组件。

### 2. 实例获取统一

React 上下文（组件、自定义 Hook）统一通过 `useAppFeedback()` 获取 `message` / `notification`。接口类型由 `lib/feedback.ts` 定义，禁止导出第三方通知实例及类型。

store、工具函数等非 React 上下文使用统一封装方法：

- `showGlobalMessage()`
- `showGlobalNotification()`

禁止在 React 上下文绕过统一入口直接调用全局实例。

`AppUiProvider` 负责主题、浮层容器与通知适配。非 React 入口使用同一适配器；挂载前或卸载期间的消息排队，重新注册后按顺序发送一次，清理仅作用于所属注册。禁止静态第三方通知兜底。

### 3. 通知规范

通知时间保持统一：

- 成功/提示：短时间展示
- 错误信息：根据内容复杂度适当延长
- 包含详细说明的错误允许更长展示时间

### 4. 去重

同节点、同来源可能重复触发的通知必须使用唯一标识进行去重。

---

## 八、前端分层与组件边界规范

### 1. 分层原则

前端代码遵循以下依赖方向：

```
页面与路由（app）
        ↓
业务组件与业务逻辑（features）
        ↓
项目 UI 基础层（components/ui）
        ↓
Radix UI primitives、样式与图标实现
```

依赖只能向下。

禁止：

- `features/*`、`app/*` 直接依赖 Radix、第三方 UI 库、图标库或 SVG 资源。
- `components/ui` 包含业务请求、领域状态或业务规则。
- UI 基础组件反向依赖 `features/*`。
- 通过兼容层、别名组件或旧 API 保留已经废弃的通用控件。

### 2. 领域层规范

`features/*` 属于业务领域层。

内部可以包含：

- 领域组件
- 页面组合组件
- hooks
- services
- stores
- types

负责：

- 产品能力实现
- 业务流程
- 状态管理
- 数据转换
- 业务规则
- 领域逻辑调用

业务组件应该表达：

> 这个功能是什么。

例如：

- `ImageNode`
- `VideoNode`
- `AgentDrawer`
- `CanvasContextMenu`
- 生成流程和工作流组件

业务组件可以：

- 连接业务 hooks、stores 和 services；
- 根据领域状态组织界面和交互；
- 将领域数据转换成 UI 组件需要的普通 props；
- 组合 `components/ui` 中的通用控件。

复杂且可复用的业务规则、数据请求和状态转换应放在 `hooks`、`services`、`stores` 或 `types` 中，避免把完整领域规则堆在 JSX 内。业务组件负责业务展示和交互编排，不负责实现通用控件或直接接入第三方 UI 库。

主交互优先使用 `components/ui` 中的 shadcn 组件；业务外层只负责布局、尺寸、间距和定位，不重写组件的交互语义、焦点管理、浮层层级或主题状态。

组件迁移时补充检查：

- 根据内容形态选择官方 `variant` 和 `size`；包含多个子元素的复合触发器不要使用固定宽度的 `icon` 尺寸。
- 交互元素不得嵌套；需要同时支持选择和操作时，将选择控件与操作控件拆为并列元素，外层只负责布局或浮层触发。
- 悬停隐藏的交互控件必须保留 `focus-visible` 状态，确保键盘操作时可见且可用。
- 选中态使用主题 token，并明确检查官方 hover、focus 和 disabled 样式是否覆盖业务状态。
- 全选、部分选中等选择状态统一使用 `components/ui/checkbox`；部分选中必须传递 `checked="indeterminate"`，不得手绘横杠或勾选框。
- Checkbox、Switch 及其 FieldLabel 外层状态统一读取 Radix 的 `data-state`（`checked`、`unchecked`、`indeterminate`）；禁止使用不会匹配的 `data-checked`、`data-unchecked` 或 `has-data-checked` 选择器。
- 可折叠内容统一使用 `components/ui/collapsible`；需要动画时读取 Radix 的 `--radix-collapsible-content-height`，不得用 `inert`、常驻隐藏节点或 `grid-template-rows` 伪造折叠状态。
- 业务语义色可以保留在标准控件上：例如 API 模型能力按钮用文字、图片、视频的颜色区分模型类型；迁移控件时保留该语义色，不要为追求统一而改成无差别的主题色。

### 3. UI 基础层规范

`components/ui` 是项目维护的 shadcn/ui 组件层，也是业务层使用的 UI 契约。shadcn/ui 组件以源码形式存在于仓库中，不把第三方组件库作为业务运行时 API。

负责：

- 通用交互组件和可访问性行为；
- shadcn/ui 组件源码及项目主题样式；
- 统一的尺寸、变体、状态和键盘交互；
- Radix primitive、图标库与 SVG 实现的隔离。

通用组件使用 shadcn/ui 的标准命名和调用方式，例如：

```tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
```

UI 基础层：

- 不包含业务状态、业务请求、领域规则或具体业务流程；
- 可以导入 Radix、`class-variance-authority`、`clsx`、`tailwind-merge` 和图标实现；
- 对外提供 shadcn 风格的标准组件 API，不创建只转发 props 的 `App*` 通用适配器；
- 只有在增加真实通用行为、可访问性或组合价值时，才创建项目级 UI 组合组件。

业务特有的组合组件必须放在对应的 `features/*` 中。例如 `DeleteProjectDialog`、`ModelSelector` 和 `AssetPicker` 可以组合多个 UI 基础组件，但不能反向成为 `components/ui` 的业务依赖。

图标也属于 UI 实现的一部分。`features/*`、`app/*`、`hooks/*`、`lib/*`、`providers/*` 禁止直接导入任何图标库（包括 `@ant-design/icons`、`lucide-react`）或 SVG 图标文件；业务层只能使用 `components/ui` 提供的图标组件、带图标能力的通用控件或其他项目级 UI 出口。图标库与 SVG 资源的选择、映射和替换全部留在 `components/ui` 内部。

`components/ui/icons` 是运行时图标的唯一实现层，图标以 React 组件形式提供，并遵循项目图标契约：使用 `currentColor`，支持 `className`、`style` 和尺寸控制；新增或替换图标时应支持标准 SVG 属性。原始 `.svg` 文件可以作为设计源或组件生成输入，但不得由业务层直接导入；不得通过 `public` 路径或资源 URL 绕过 UI 出口使用图标。图标的具体存储方式可以调整，但对业务层暴露的始终是项目定义的 UI 组件契约。

`ParamFields` / `ParamSummary` 只消费已解析的展示描述。模型默认值、提交字段判断、翻译约定与自适应比例语义由 `features/model/param-fields.ts` 处理，UI 层不反向依赖领域适配器。

### 4. 第三方 UI 库使用规范

Radix UI 是 `components/ui` 的基础实现，shadcn/ui 是项目维护的组件源码组织方式和主题约定。

原则：

1. 业务代码只从 `components/ui` 获取通用 UI 能力。
2. `components/ui` 可以使用 Radix primitive 和其他基础实现。
3. 业务代码不直接依赖 Radix Props、事件对象、组件对象或第三方 UI 类型。
4. 通用组件迁移时直接更新所有调用方，不保留旧 API、转发文件或临时兼容层。
5. 不为了形式上的统一而包装没有新增价值的组件。

**Radix UI 接入约定**：

- 项目采用 Radix UI primitives 作为需要成熟无障碍行为、焦点管理和浮层管理的控件基础实现。
- 组件代码由项目维护，并遵循 shadcn/ui 的组织方式、主题变量和样式组合方式。
- `components/ui` 可以导入 `@radix-ui/*`；`features/*`、`app/*`、`hooks/*`、`lib/*`、`providers/*` 不得直接导入 Radix。
- 业务组件使用 `components/ui` 的标准组件 API，不直接使用 primitive 的底层类型和事件对象。
- 简单控件可以继续使用原生元素和项目主题；只有存在真实的交互、无障碍或浮层管理价值时才引入对应 Radix primitive。
- `SheetContent` 统一采用容器优先的初始焦点策略，打开侧栏时不会把焦点自动落到新建、历史或关闭等导航动作上；关闭时由 Radix 恢复到打开前的触发元素。
- `DialogContent` 统一按“`data-autofocus` 标记、可编辑表单控件、对话框容器”的顺序确定初始焦点，动作按钮不作为默认焦点；业务组件不得为规避默认焦点在每个 Dialog 或 Sheet 上重复实现 `onOpenAutoFocus`。
- `DropdownMenuContent` 在鼠标点击外部时保留外部交互的焦点结果，不让 Radix 把焦点强制恢复到触发器；键盘关闭和菜单项选择继续使用标准触发器回焦行为。
- Radix 的浮层组件继续使用官方 body-level Portal；Portal 挂载、焦点和定位由 Radix 管理，跨 Dialog / Sheet / 确认框的 z-index 只由 `components/ui/modal/layer-context.ts` 统一计算和传递。业务组件不得为单个菜单、Select、Popover 或 Tooltip 新增 z-index、Portal 容器或层级兜底。
- 迁移完成后删除遗留的通用 `App*` 适配器和不再使用的旧通用 CSS；项目级 Provider、图标出口和反馈出口如果承担明确的基础设施职责，可以保留在 `components/ui`。画布、节点、Director、登录页等领域样式继续由对应领域负责。

**强制约束**（由 `eslint.config.mjs` 保证，违反无法合入）：

- `src/features/**`、`src/app/**`、`src/hooks/**`、`src/lib/**`、`src/providers/**` 禁止导入、重新导出或动态加载具体 UI 库及其子路径，包括类型与通知入口。
- 当前运行时不再依赖 antd；未来引入或替换第三方 UI 实现时，只允许在 `components/ui` 内部接入。所有图标库和 SVG 图标资源也只允许由 `components/ui` 导入，业务层不得直接依赖 `@ant-design/icons`、`lucide-react` 或具体 SVG 文件。
- 业务组件直接使用 `components/ui` 中的 shadcn 组件；通用 UI 不再通过 `App*` 转发层访问。
- 具体实现与主题样式集中在 `components/ui` 和全局设计令牌中；业务流程和领域组件集中在 `features/*`。
- 跨层依赖由 `boundaries/dependencies` 以 error 级别强制：app → feature → ui → lib，反向依赖直接报错。

### 5. 组件归属判断

| 组件表达的内容 | 归属位置 | 示例 |
| --- | --- | --- |
| 页面和路由组合 | `app/*` | 页面入口、布局、路由参数组合 |
| 产品能力和业务交互 | `features/*/components` | `ImageNode`、`VideoNode`、Agent 功能、生成流程 |
| 通用界面能力 | `components/ui` | `Button`、`Input`、`Dialog`、`Tooltip`、`DropdownMenu` |
| 第三方技术实现 | `components/ui` 内部 | Radix primitive、图标库、SVG 组件 |

---

## 九、核心领域优先保护原则

### 1. 核心领域修改原则

以下模块属于核心业务领域：

- canvas
- agent
- workflow
- generation
- node system
- task state

修改这些模块时：

1. 优先考虑领域边界。
2. 避免将 UI 细节混入业务逻辑。
3. 避免通过临时组件或特殊判断解决长期架构问题。
4. 大范围调整前必须说明影响范围。

### 2. 重构后的维护约束

- 交互控件的颜色、边框、焦点和悬停状态优先使用主题 token（如 `bg-background`、`bg-popover`、`text-foreground`、`border-input`、`ring-ring`）；业务组件不得用硬编码颜色覆盖基础组件的主题契约。
- Checkbox 的状态样式必须匹配 Radix 的 `data-state="checked"` / `data-state="indeterminate"`，选中和半选背景、边框及图标颜色统一走主题 token。
- 媒体缩略图底部的信息条统一使用黑色半透明背景和白色文字（与资产卡片一致），明暗主题保持相同，确保覆盖在不同内容上时有稳定对比度。
- 媒体卡片右上角的删除角标与资产卡片的 `+` 操作统一使用透明背景、白色图标，悬停或聚焦时使用 `bg-white/15`；保留 `focus-visible` 可见状态，不使用红色作为默认删除角标颜色。
- 图片、视频等媒体悬浮预览统一由 `HoverCardContent` 提供外层边框、圆角、背景和裁剪；媒体元素本身不得重复添加边框、圆角或背景，避免出现双层边框。
- Dialog、Sheet、Popover、DropdownMenu、Tooltip 和 Tabs 统一使用 `components/ui` 的实现。业务层只组合标准 API，不重复实现焦点恢复、浮层定位、关闭和键盘行为。
- `DialogTitle` 用于标题，`DialogDescription` 只放简短的说明文本；表单、列表、代码块和其他结构化内容放在普通容器中，避免产生无效 HTML 或 hydration 错误。
- 共享 UI 组件的行为变更应覆盖键盘操作、焦点转移、鼠标关闭、主题 token 和 Portal 渲染等关键路径；业务组件只补充自身领域行为测试。
- 临时日志、构建输出和调试文件不得进入源码目录或版本控制。一次性迁移脚本在没有 package、CI 或维护流程引用后应删除；持续性检查必须由 lint、测试或构建流程负责。

### 3. 画布连线视觉约定

- 节点之间连线的动态流光统一使用 `EDGE_FLOW_COLOR`（`#c7f43d`）；已建立连线、拖拽连线预览和待创建连线预览共用该常量。
- 连线管道本体继续使用 `EDGE_BASE_COLOR` 的主题中性色，不能用流光色覆盖本体，以保留流动方向和强调层次。

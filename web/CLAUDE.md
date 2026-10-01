@AGENTS.md

# 前端架构与实现规范

> 本文件是《项目协作规则》的前端部分，章节编号沿用规则原文档。总体协作规则见仓库根目录 `../CLAUDE.md`。

## 七、消息通知规范

### 1. 场景分工

根据消息类型选择对应通知方式：

- 用户当前操作的即时反馈（复制、保存、上传等）使用轻量级消息提示。
- 异步任务结果、后台处理结果以及需要展示详细信息的错误使用通知组件。

### 2. 实例获取统一

React 上下文（组件、自定义 Hook）统一通过项目规定的通知实例获取方式调用。

store、工具函数等非 React 上下文使用统一封装方法：

- `showGlobalMessage()`
- `showGlobalNotification()`

禁止在 React 上下文绕过统一入口直接调用全局实例。

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
业务领域层（features）
        ↓
UI 基础层（components/ui）
        ↓
UI 实现层（第三方组件库或基础实现）
```

依赖只能向下。

禁止：

- 业务领域层依赖具体 UI 实现。
- UI 基础层包含业务规则。
- 第三方组件库 API 直接成为业务逻辑的一部分。
- 核心业务组件与具体 UI 实现强绑定。

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

领域组件应该表达：

> 这个功能是什么。

例如：

- Canvas 节点
- Agent 功能模块
- 生成流程
- 工作流逻辑

领域层不负责：

- 通用 UI 组件实现
- 样式系统
- 第三方 UI 库封装

### 3. UI 基础层规范

`components/ui` 是项目 UI 基础层。

负责：

- 通用交互组件
- 样式统一
- 主题管理
- UI 行为封装
- 隔离第三方 UI 实现差异

例如：

- Button
- Modal
- Tooltip
- Dropdown
- Form 控件

UI 基础层：

- 可以依赖第三方 UI 实现。
- 不包含业务状态。
- 不包含业务请求。
- 不包含领域规则。
- 不处理具体业务流程。

**当前已有出口**（新增通用能力前先查这里，禁止重复实现）：

| 类别 | 出口 |
| --- | --- |
| 按钮与动作 | `AppButton`（原生元素 + CSS 类，变体 primary/default/ghost/danger）、`NavButton`、`IconActionButton`（圆形图标主操作，含 loading / cancel 态）、`DialogActions`（弹窗底部「取消 + 主行动」区） |
| 弹窗 | `AppModal`（全站弹窗基座，内含 layer 层级系统）、`ConfirmModal`（二次确认） |
| 表单字段 | `ParamFields`（声明式参数渲染：segmented/select/slider/switch/number）、`ParamSummary`、`AppInput`、`AppNumberInput`、`AppCheckbox` |
| 提示与浮层 | `AppTooltip`、`AppPopover`、`AppEmpty`、`TaskErrorDetail`（长文折叠详情） |
| 选择与取值 | `AppDropdown`、`AppMenu`、`AppSlider`、`AppColorPicker` |
| 容器与列表 | `AppDrawer`、`VirtualList`、`WheelGuard` |
| 展示 | `AppDescriptions`、`AppTypography` |
| 图标资产 | `icons/`（纯 SVG，无业务规则，可被各层直接引用） |

出口分两种写法，按代价选择：

- 已有 CSS 语言覆盖的能力（如按钮）用**原生元素 + 语义 CSS 类**实现，不包第三方壳。
- 交互复杂、自研代价高的能力（Tooltip / Slider / ColorPicker / Dropdown 等）由出口**隔离第三方实现**：对外只认 `App*`，替换底层库时只改出口文件。

出口的公共契约由项目定义，不直接导出第三方完整 Props、组件对象或事件对象。颜色、勾选与菜单选择等回调返回普通值或项目声明的数据；第三方类型与转换只在 UI 实现内部使用。

`ParamFields` / `ParamSummary` 只消费已解析的展示描述。模型默认值、提交字段判断、翻译约定与自适应比例语义由 `features/model/param-fields.ts` 处理，UI 层不反向依赖领域适配器。

### 4. 第三方 UI 库使用规范

第三方 UI 库属于基础实现层。

原则：

1. 不禁止使用成熟 UI 库。
2. 业务代码不应该直接依赖具体 UI 库实现细节。
3. 核心业务领域新增代码优先通过 UI 基础层获取通用 UI 能力。
4. 已存在代码逐步优化，不进行无业务价值的大规模迁移。
5. 不为了追求形式上的架构纯净进行过度抽象。

**强制约束**（由 `eslint.config.mjs` 保证，违反无法合入）：

- 核心业务领域（`src/features/canvas/**`）禁止直接 `import` 第三方 UI 库的 UI 组件，必须走八.3 的 `App*` 出口。
- 例外：`App`（`App.useApp()`）是通知入口，不算 UI 组件依赖。
- 非核心目录（assets / director / settings / auth / project）不受此约束，避免无业务价值的迁移。
- 跨层依赖由 `boundaries/dependencies` 以 error 级别强制：app → feature → ui → lib，反向依赖直接报错。

### 5. 组件归属判断

| 组件表达的内容 | 归属位置 | 示例 |
| --- | --- | --- |
| 产品能力是什么 | `features/*` | Canvas 节点、Agent 功能、生成流程、工作流逻辑 |
| 通用界面能力如何实现 | `components/ui` | Button、Modal、Tooltip、Dropdown |
| 第三方技术实现 | UI 实现层 | 第三方组件库 |

---

## 九、核心领域优先保护原则

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

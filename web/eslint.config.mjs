import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";
import checkFile from "eslint-plugin-check-file";
import reactHooks from "eslint-plugin-react-hooks";
import simpleImportSort from "eslint-plugin-simple-import-sort";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: {
      "check-file": checkFile,
      "simple-import-sort": simpleImportSort,
      "react-hooks": reactHooks,
      "boundaries": boundaries,
    },
    settings: {
      // ── 架构分层元素类型（eslint-plugin-boundaries）──────────────────
      // 按目录/文件名划分架构层级，作为依赖矩阵的判定依据。
      // 跨模块“只能走 index.ts”无法由该插件表达，由
      // `src/__tests__/architecture/module-boundaries.test.ts` 统一执行。
      "boundaries/elements": [
        { type: "app", pattern: "app" },
        { type: "app", pattern: "providers" },
        { type: "app", pattern: "components/layout" },
        { type: "feature", pattern: "features/*", capture: ["featureName"] },
        { type: "entity", pattern: "entities/*", capture: ["entityName"] },
        { type: "shared-ui", pattern: "components/ui" },
        { type: "shared-ui", pattern: "components/media" },
        { type: "shared-ui", pattern: "components/model" },
        { type: "shared-lib", pattern: "lib" },
        { type: "shared-types", pattern: "types" },
      ],
      // 排除测试文件，避免测试中的跨层 mock 产生误报。
      "boundaries/ignore": ["**/*.test.ts", "**/*.test.tsx"],
    },
    rules: {
      // 业务组件（.tsx）统一 PascalCase（符合 React 行业惯例），
      // shadcn/ui 源码遵循官方约定使用 kebab-case；非组件（.ts）与测试统一 kebab-case。
      // Next.js 约定文件（page/layout/loading/error/not-found/template 等）固定小写，必须豁免。
      // 注意：glob 必须互斥，否则组件 .tsx 会同时命中默认 kebab 规则而误报。
      "check-file/filename-naming-convention": [
        "error",
          {
            "src/**/*.test.ts": "KEBAB_CASE",
            "src/**/*.ts": "KEBAB_CASE",
            "src/app/**/*.tsx": "@(page|layout|loading|error|not-found|template|route|global-error|index)",
          "src/components/ui/**/*.tsx": "KEBAB_CASE",
          "src/components/!(ui)/**/*.tsx": "PASCAL_CASE",
          "src/!(app|components)/**/*.tsx": "PASCAL_CASE",
        },
        { ignoreMiddleExtensions: true },
      ],
      // import / export 分组与排序：external → @/ → 相对
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      // any 在 3D 引擎（three.js 交互）与测试 mock 中大量使用，保持 error 级别，
      // 违规逐项清理（见各文件专项处理），不降级。
      "@typescript-eslint/no-explicit-any": "error",
      // 「丢弃键 + rest」解构（const { groupId: _omit, ...rest } = data）是刻意的
      // 剥离写法，ignoreRestSiblings 正是为它准备的选项（use-group-operations /
      // canvas-edit-actions 剥离 groupId 归属），不再报未使用变量。
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
      // 历史技术债：Function 类型（@typescript-eslint/ban-types），降级为 warn 保留提示。
      "@typescript-eslint/no-unsafe-function-type": "warn",
      // react-hooks v6 规则保持 error 级别，违规逐项修复（见各文件清理），不降级。

      // ── 架构分层约束（eslint-plugin-boundaries）──────────────────────
      // app → features → entities → shared；默认禁止一切跨层依赖。
      // feature 之间的隔离与“只允许公共入口”由架构测试负责（插件无法按 capture 判定同名内部）。
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          // v6 起 allow/disallow 必须用 from/to 包装，裸元素选择器会被忽略。
          policies: [
            // app 可组合所有下层模块
            {
              from: { element: { type: "app" } },
              allow: [
                { to: { element: { type: "app" } } },
                { to: { element: { type: "feature" } } },
                { to: { element: { type: "entity" } } },
                { to: { element: { type: "shared-ui" } } },
                { to: { element: { type: "shared-lib" } } },
                { to: { element: { type: "shared-types" } } },
              ],
            },
            // feature 只能向下依赖 entity / shared
            {
              from: { element: { type: "feature" } },
              allow: [
                { to: { element: { type: "feature" } } },
                { to: { element: { type: "entity" } } },
                { to: { element: { type: "shared-ui" } } },
                { to: { element: { type: "shared-lib" } } },
                { to: { element: { type: "shared-types" } } },
              ],
            },
            // entity 只能依赖 entity（公共 API）与 shared
            {
              from: { element: { type: "entity" } },
              allow: [
                { to: { element: { type: "entity" } } },
                { to: { element: { type: "shared-ui" } } },
                { to: { element: { type: "shared-lib" } } },
                { to: { element: { type: "shared-types" } } },
              ],
            },
            // shared 只能依赖 shared
            {
              from: { element: { type: ["shared-ui", "shared-lib", "shared-types"] } },
              allow: [
                { to: { element: { type: "shared-ui" } } },
                { to: { element: { type: "shared-lib" } } },
                { to: { element: { type: "shared-types" } } },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    // shadcn/ui 官方组件文件使用 kebab-case；组件目录内的命名由 shadcn 约定统一管理。
    files: ["src/components/ui/**/*.tsx"],
    rules: {
      "check-file/filename-naming-convention": "off",
    },
  },
  // 全局 message/notification wrapper 的使用边界（见根 AGENTS.md「七、消息通知规范」）。
  // 策略：白名单制——默认全项目禁止引入 wrapper（React 上下文一律 useAppFeedback()），
  // 仅下方 ignores 白名单内的非 React 模块（store / 工具函数 / wrapper 注册方）放行。
  // 新增合法消费者时在此补一行；改配置这个动作本身就是“确认过确实不在 React 上下文”。
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/entities/asset/store.ts",
      "src/entities/asset/upload.ts",
      "src/entities/user/store.ts",
      "src/entities/project/store.ts",
      "src/lib/model-store.ts",
      "src/lib/utils/download.ts",
      "src/features/canvas/upload/upload-pipeline.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/global-message",
              message: "React 组件/Hook 内一律 useAppFeedback() 解构 message；此 wrapper 仅供非 React 上下文使用（AGENTS.md 七）",
            },
            {
              name: "@/lib/global-notification",
              message: "React 组件/Hook 内一律 useAppFeedback() 解构 notification；此 wrapper 仅供非 React 上下文使用（AGENTS.md 七）",
            },
          ],
        },
      ],
    },
  },
  // 具体第三方 UI 实现及类型只允许在 UI 基础层出现，通知入口也属于 UI 适配。
  {
    files: ["src/features/**/*.{ts,tsx}", "src/entities/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}", "src/providers/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportDeclaration[source.value='antd']",
          message: "业务代码禁止依赖 antd 实现和类型，请使用 App* 控件或 useAppFeedback（web/AGENTS.md 八）",
        },
        {
          selector: "ImportDeclaration[source.value=/^antd\\//]",
          message: "核心领域禁止通过 antd 子路径导入实现，请使用 App* 出口",
        },
        {
          selector: "ImportDeclaration[source.value=/^@ant-design\\/icons($|\\/)/]",
          message: "业务代码禁止直接依赖图标库，请使用 components/ui 的项目图标出口",
        },
        {
          selector: "ImportDeclaration[source.value='lucide-react']",
          message: "业务代码禁止直接依赖具体图标库，请使用 components/ui 的项目图标出口",
        },
        {
          selector: "ImportDeclaration[source.value=/^@\\/components\\/ui\\/icons\\//]",
          message: "业务代码禁止直接导入图标实现，请使用 components/ui 的项目图标出口",
        },
        {
          selector: "ImportDeclaration[source.value=/\\.svg$/]",
          message: "业务代码禁止直接导入 SVG 资源，请使用 components/ui 的项目图标出口",
        },
        {
          selector: ":matches(ExportNamedDeclaration, ExportAllDeclaration)[source.value=/^antd($|\\/)/]",
          message: "核心领域禁止重新导出 antd 实现，请使用 App* 出口",
        },
        {
          selector: ":matches(ExportNamedDeclaration, ExportAllDeclaration)[source.value=/^@ant-design\\/icons($|\\/)/]",
          message: "业务代码禁止重新导出图标库实现，请使用 components/ui 的项目图标出口",
        },
        {
          selector: ":matches(ExportNamedDeclaration, ExportAllDeclaration)[source.value='lucide-react']",
          message: "业务代码禁止重新导出具体图标库，请使用 components/ui 的项目图标出口",
        },
        {
          selector: ":matches(ExportNamedDeclaration, ExportAllDeclaration)[source.value=/^@\\/components\\/ui\\/icons\\//]",
          message: "业务代码禁止重新导出图标实现，请使用 components/ui 的项目图标出口",
        },
        {
          selector: ":matches(ExportNamedDeclaration, ExportAllDeclaration)[source.value=/\\.svg$/]",
          message: "业务代码禁止重新导出 SVG 资源，请使用 components/ui 的项目图标出口",
        },
        {
          selector: "ImportExpression[source.value=/^antd($|\\/)/]",
          message: "核心领域禁止动态导入 antd 实现，请使用 App* 出口",
        },
        {
          selector: "ImportExpression[source.value=/^@ant-design\\/icons($|\\/)/]",
          message: "业务代码禁止动态导入图标库实现，请使用 components/ui 的项目图标出口",
        },
        {
          selector: "ImportExpression[source.value='lucide-react']",
          message: "业务代码禁止动态导入具体图标库，请使用 components/ui 的项目图标出口",
        },
        {
          selector: "ImportExpression[source.value=/^@\\/components\\/ui\\/icons\\//]",
          message: "业务代码禁止动态导入图标实现，请使用 components/ui 的项目图标出口",
        },
        {
          selector: "ImportExpression[source.value=/\\.svg$/]",
          message: "业务代码禁止动态导入 SVG 资源，请使用 components/ui 的项目图标出口",
        },
        {
          selector: "TSImportType[source.value=/^antd($|\\/)/]",
          message: "业务代码禁止通过 import() 类型引用 antd，请使用项目接口",
        },
        {
          selector: "TSImportType[source.value=/^@ant-design\\/icons($|\\/)/]",
          message: "业务代码禁止通过 import() 类型引用图标库，请使用项目图标接口",
        },
        {
          selector: "TSImportType[source.value='lucide-react']",
          message: "业务代码禁止通过 import() 类型引用具体图标库，请使用项目图标接口",
        },
        {
          selector: "TSImportType[source.value=/^@\\/components\\/ui\\/icons\\//]",
          message: "业务代码禁止通过 import() 类型引用图标实现，请使用项目图标接口",
        },
        {
          selector: "TSImportType[source.value=/\\.svg$/]",
          message: "业务代码禁止通过 import() 类型引用 SVG 资源，请使用项目图标接口",
        },
        {
          selector: "JSXAttribute[name.name='className'] Literal[value=/(^|\\s)ant-/]",
          message: "业务 JSX 使用项目语义类名，第三方类名只允许出现在 UI 实现内",
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value=/^antd($|\\/)/]",
          message: "核心领域禁止 require antd 实现，请使用 App* 出口",
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value=/^@ant-design\\/icons($|\\/)/]",
          message: "业务代码禁止 require 图标库实现，请使用 components/ui 的项目图标出口",
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value='lucide-react']",
          message: "业务代码禁止 require 具体图标库，请使用 components/ui 的项目图标出口",
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value=/^@\\/components\\/ui\\/icons\\//]",
          message: "业务代码禁止 require 图标实现，请使用 components/ui 的项目图标出口",
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value=/\\.svg$/]",
          message: "业务代码禁止 require SVG 资源，请使用 components/ui 的项目图标出口",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;

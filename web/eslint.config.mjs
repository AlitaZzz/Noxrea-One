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
      // 按目录/文件名划分架构层级，作为 allowed-modules 规则的判定依据。
      "boundaries/elements": [
        { type: "app", pattern: "app" },
        { type: "feature", pattern: "features" },
        { type: "ui", pattern: "components/ui" },
        { type: "store", pattern: "**/stores/*" },
        // lib 必须在元素表里声明：否则 policies 中引用 { type: "lib" } 的策略全部静默失效。
        { type: "lib", pattern: "lib" },
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
      // dependencies 规则：默认禁止一切跨层依赖，仅放开白名单策略。
      // 上层可依赖下层，禁止反向（如 lib 禁止依赖 feature/ui/app）。
      // 存量违规已清零，故提级为 error：新增跨层依赖无法合入。
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          // v6 起 allow/disallow 必须用 from/to 包装，裸元素选择器会被忽略（此前 5 条策略全部静默失效）。
          policies: [
            // app 可依赖一切
            {
              from: { element: { type: "app" } },
              allow: [
                { to: { element: { type: "app" } } },
                { to: { element: { type: "feature" } } },
                { to: { element: { type: "ui" } } },
                { to: { element: { type: "lib" } } },
                { to: { element: { type: "store" } } },
              ],
            },
            // feature 可依赖 ui / lib / store，禁止依赖 app
            {
              from: { element: { type: "feature" } },
              allow: [
                { to: { element: { type: "ui" } } },
                { to: { element: { type: "lib" } } },
                { to: { element: { type: "store" } } },
                { to: { element: { type: "feature" } } },
              ],
            },
            // ui 仅可依赖 lib，禁止依赖 feature / app
            {
              from: { element: { type: "ui" } },
              allow: [
                { to: { element: { type: "lib" } } },
                { to: { element: { type: "ui" } } },
              ],
            },
            // store 仅可依赖 lib
            {
              from: { element: { type: "store" } },
              allow: [
                { to: { element: { type: "lib" } } },
                { to: { element: { type: "store" } } },
              ],
            },
            // lib 为最底层，禁止依赖任何上层
            {
              from: { element: { type: "lib" } },
              allow: [{ to: { element: { type: "lib" } } }],
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
      "src/features/assets/store.ts",
      "src/features/auth/store.ts",
      "src/features/project/store.ts",
      "src/lib/model-store.ts",
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
    files: ["src/features/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}", "src/hooks/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}", "src/providers/**/*.{ts,tsx}"],
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

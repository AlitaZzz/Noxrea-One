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
      ],
      // 排除测试文件，避免测试中的跨层 mock 产生误报。
      "boundaries/ignore": ["**/*.test.ts", "**/*.test.tsx"],
    },
    rules: {
      // 文件名命名约定：组件（.tsx）统一 PascalCase（符合 React 行业惯例），
      // 非组件（.ts）与测试（.test.ts）统一 kebab-case。
      // Next.js 约定文件（page/layout/loading/error/not-found/template 等）固定小写，必须豁免。
      // 注意：glob 必须互斥，否则组件 .tsx 会同时命中默认 kebab 规则而误报。
      "check-file/filename-naming-convention": [
        "error",
        {
          "src/**/*.test.ts": "KEBAB_CASE",
          "src/**/*.ts": "KEBAB_CASE",
          "src/app/**/*.tsx": "@(page|layout|loading|error|not-found|template|route|global-error|index)",
          "src/!app/**/*.tsx": "PASCAL_CASE",
        },
        { ignoreMiddleExtensions: true },
      ],
      // import / export 分组与排序：external → @/ → 相对
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      // any 在 3D 引擎（three.js 交互）与测试 mock 中大量使用，保持 error 级别，
      // 违规逐项清理（见各文件专项处理），不降级。
      "@typescript-eslint/no-explicit-any": "error",
      // 历史技术债：Function 类型（@typescript-eslint/ban-types），降级为 warn 保留提示。
      "@typescript-eslint/no-unsafe-function-type": "warn",
      // react-hooks v6 规则保持 error 级别，违规逐项修复（见各文件清理），不降级。

      // ── 架构分层约束（eslint-plugin-boundaries）──────────────────────
      // dependencies 规则：默认禁止一切跨层依赖，仅放开白名单策略。
      // 上层可依赖下层，禁止反向（如 lib 禁止依赖 feature/ui/app）。
      "boundaries/dependencies": [
        "warn",
        {
          default: "disallow",
          policies: [
            // app 可依赖一切
            {
              from: { element: { type: "app" } },
              allow: { element: [{ type: "app" }, { type: "feature" }, { type: "ui" }, { type: "lib" }, { type: "store" }] },
            },
            // feature 可依赖 ui / lib / store，禁止依赖 app
            {
              from: { element: { type: "feature" } },
              allow: { element: [{ type: "ui" }, { type: "lib" }, { type: "store" }, { type: "feature" }] },
            },
            // ui 仅可依赖 lib，禁止依赖 feature / app
            {
              from: { element: { type: "ui" } },
              allow: { element: [{ type: "lib" }, { type: "ui" }] },
            },
            // store 仅可依赖 lib
            {
              from: { element: { type: "store" } },
              allow: { element: [{ type: "lib" }, { type: "store" }] },
            },
            // lib 为最底层，禁止依赖任何上层
            {
              from: { element: { type: "lib" } },
              allow: { element: [{ type: "lib" }] },
            },
          ],
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

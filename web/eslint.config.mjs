import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
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
    },
    rules: {
      // 文件名命名约定：组件 PascalCase，测试 kebab，其余 kebab-case。
      // 注意：glob 必须互斥，否则组件 .tsx 会同时命中默认 kebab 规则而误报。
      "check-file/filename-naming-convention": [
        "error",
        {
          "src/components/**/*.tsx": "PASCAL_CASE",
          "src/**/*.test.ts": "KEBAB_CASE",
          "src/**/*.ts": "KEBAB_CASE",
          "src/!(components)/**/*.tsx": "KEBAB_CASE",
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

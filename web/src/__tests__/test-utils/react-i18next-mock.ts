/**
 * `react-i18next` 的测试替身：组件用到的 `useTranslation` + 真实模块的
 * `initReactI18next`。
 *
 * 只 mock `useTranslation` 是不够的：被测模块的依赖链一旦在顶层导入
 * `@/lib/i18n/config`（例如 `@/lib/file-access` → `@/lib/api/client` →
 * `error-message`），i18n 初始化就要求 `initReactI18next` 存在，缺失会让
 * 整个测试文件在收集阶段失败。用法：
 *
 * ```ts
 * vi.mock("react-i18next", () => import("@/__tests__/test-utils/react-i18next-mock"));
 * ```
 */

/** 形状与 react-i18next 的真实导出一致：`i18next.use()` 只读取 type / init */
export const initReactI18next = {
  type: "3rdParty",
  init: () => undefined,
};

/** 直接返回 key，组件断言不依赖具体文案 */
export function useTranslation() {
  return {
    t: (key: string) => key,
    i18n: { language: "zh" },
  };
}

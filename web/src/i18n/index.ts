/**
 * 多语言文案入口。
 * 汇总中英文案表并导出语言类型 Lang，实际翻译函数由 i18n-store 提供。
 */
import enUS from "./en-US.json";
import zhCN from "./zh-CN.json";

export type Lang = "zh" | "en";

export const messages: Record<Lang, Record<string, string>> = {
  zh: zhCN,
  en: enUS,
};

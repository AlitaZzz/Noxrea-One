import zhCN from "./zh-CN.json";
import enUS from "./en-US.json";

export type Lang = "zh" | "en";

export const messages: Record<Lang, Record<string, string>> = {
  zh: zhCN,
  en: enUS,
};

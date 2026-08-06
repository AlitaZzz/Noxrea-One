/**
 * 多语言状态仓库：保存当前语言并提供文案翻译函数 t。
 */
import { create } from "zustand";

import type { Lang } from "@/lib/i18n";
import { messages } from "@/lib/i18n";

interface I18nState {
  lang: Lang;
  toggle: () => void;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
}

export const useI18nStore = create<I18nState>((set, get) => ({
  lang: "zh",
  toggle: () => {
    const next = get().lang === "zh" ? "en" : "zh";
    set({ lang: next });
  },
  setLang: (l) => set({ lang: l }),
  t: (key: string) => {
    const dict = messages[get().lang];
    return dict[key] || key;
  },
}));

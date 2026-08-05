import { create } from "zustand";

import type { Lang } from "@/i18n";
import { messages } from "@/i18n";

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

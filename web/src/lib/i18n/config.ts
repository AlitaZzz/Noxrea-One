"use client";

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enUS from "./en-US.json";
import zhCN from "./zh-CN.json";

export type Lang = "zh" | "en";

export const SUPPORTED_LANGS: Lang[] = ["zh", "en"];

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zhCN },
    en: { translation: enUS },
  },
  lng: "zh",
  fallbackLng: "zh",
  keySeparator: ".",
  nsSeparator: ":",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;

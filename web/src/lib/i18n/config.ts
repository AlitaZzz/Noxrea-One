"use client";

// 注意：本模块带 "use client" —— 服务端代码不要直接导入（根布局所需的
// LANG_COOKIE 常量在 ./lang-cookie，导入本模块会把 react-i18next 拉进 server bundle）。
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enUS from "./en-US.json";
import { LANG_COOKIE } from "./lang-cookie";
import zhCN from "./zh-CN.json";

export type Lang = "zh" | "en";

export const SUPPORTED_LANGS: Lang[] = ["zh", "en"];

// 语言持久化在非 httpOnly cookie：服务端根布局可读取并在 SSR 前同步 i18n，
// 客户端 init 也读同一 cookie —— 两端首帧渲染语言一致，避免水合错配。
// （localStorage 服务端读不到，会导致 SSR 中文/客户端英文的水合差异。）
// 常量本体定义在 ./lang-cookie。

const LANG_COOKIE_RE = new RegExp(`(?:^|;\\s*)${LANG_COOKIE}=([^;]*)`);

function readLangCookie(): Lang | null {
  if (typeof document === "undefined") return null;
  try {
    const match = document.cookie.match(LANG_COOKIE_RE);
    const value = match ? decodeURIComponent(match[1]) : null;
    return SUPPORTED_LANGS.includes(value as Lang) ? (value as Lang) : null;
  } catch {
    return null;
  }
}

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zhCN },
    en: { translation: enUS },
  },
  lng: readLangCookie() ?? "zh",
  fallbackLng: "zh",
  keySeparator: ".",
  nsSeparator: ":",
  interpolation: {
    escapeValue: false,
  },
});

/**
 * 把 i18n 语言同步到指定值（服务端根布局从 cookie 读出后传入）。
 * 必须在渲染子树前同步调用（changeLanguage 同步生效），
 * 保证本次 SSR 输出与客户端水合使用同一语言。
 */
export function syncLanguage(lang: string | undefined) {
  const next = SUPPORTED_LANGS.includes(lang as Lang) ? (lang as Lang) : "zh";
  if (i18n.language !== next) void i18n.changeLanguage(next);
}

/** 切换语言的唯一入口：换语言的同时写 cookie，保证下次进站首帧即为目标语言 */
export function setAppLanguage(lang: Lang) {
  void i18n.changeLanguage(lang);
  document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=31536000; samesite=lax`;
}

export default i18n;

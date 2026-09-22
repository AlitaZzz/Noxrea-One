"use client";

import { type ReactNode } from "react";

import { syncLanguage } from "@/lib/i18n/config";

/**
 * 语言同步闸门：服务端根布局从 cookie 读出语言后经 props 传入，
 * 在渲染子树前同步 i18n，使 SSR 输出与客户端水合的语言一致。
 */
export function I18nProvider({ lang, children }: { lang?: string; children: ReactNode }) {
  syncLanguage(lang);
  return <>{children}</>;
}

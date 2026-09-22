/**
 * Next.js 应用根布局（Root Layout）。
 * 定义 <html>/<body> 骨架、站点 metadata，并挂载全局 Provider 树。
 * 不含任何业务逻辑，仅做最外层装配。
 */
import "@/styles/globals.css";

import type { Metadata } from "next";
import { cookies } from "next/headers";

import { parseUserCookie, USER_COOKIE } from "@/features/auth/user-cache";
import { CachedUserProvider } from "@/features/auth/UserContext";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { LANG_COOKIE } from "@/lib/i18n/lang-cookie";
import { AppProviders } from "@/providers/AppProviders";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Noxrea One";

export const metadata: Metadata = {
  title: APP_NAME,
  description: "AI-powered infinite canvas workspace",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 语言持久化在 cookie，服务端可读：SSR 与客户端水合使用同一语言来源。
  // 与 syncLanguage 一致地做白名单校验，防止伪造 cookie 污染 <html lang>
  const rawLang = (await cookies()).get(LANG_COOKIE)?.value;
  const lang = rawLang === "en" || rawLang === "zh" ? rawLang : "zh";
  // 用户缓存 cookie：SSR 直出真实头像/用户名，避免「占位 → 填充」闪变
  const cachedUser = parseUserCookie((await cookies()).get(USER_COOKIE)?.value);
  return (
    <html lang={lang} suppressHydrationWarning>
      <body className="m-0 p-0 overflow-hidden">
        <AppProviders>
          <CachedUserProvider user={cachedUser}>
            <I18nProvider lang={lang}>{children}</I18nProvider>
          </CachedUserProvider>
        </AppProviders>
      </body>
    </html>
  );
}

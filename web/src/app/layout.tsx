/**
 * Next.js 应用根布局（Root Layout）。
 * 定义 <html>/<body> 骨架、站点 metadata，并挂载全局 Provider 树。
 * 不含任何业务逻辑，仅做最外层装配。
 */
import "@/styles/globals.css";

import type { Metadata } from "next";
import { Figtree } from "next/font/google";
import { cookies } from "next/headers";

import { parseUserCookie, USER_COOKIE } from "@/features/auth/user-cache";
import { CachedUserProvider } from "@/features/auth/UserContext";
import enUS from "@/lib/i18n/en-US.json";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { LANG_COOKIE } from "@/lib/i18n/lang-cookie";
import zhCN from "@/lib/i18n/zh-CN.json";
import { cn } from "@/lib/utils";
import { AppProviders } from "@/providers/AppProviders";

const figtree = Figtree({subsets:['latin'],variable:'--font-sans'});

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Noxrea One";

// SEO 描述跟随 cookie 语言（服务端直读 JSON 资源，不经 react-i18next——
// i18n config 是 "use client" 模块，不能进 server bundle）
export async function generateMetadata(): Promise<Metadata> {
  const rawLang = (await cookies()).get(LANG_COOKIE)?.value;
  const description = rawLang === "en" ? enUS.meta.description : zhCN.meta.description;
  return { title: APP_NAME, description };
}

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
    <html
      lang={lang}
      className={cn(
        cachedUser?.theme === "light" ? "light" : "dark",
        "font-sans",
        figtree.variable,
      )}
    >
      <body className="m-0 p-0 overflow-hidden">
        <CachedUserProvider user={cachedUser}>
          <AppProviders>
            <I18nProvider lang={lang}>{children}</I18nProvider>
          </AppProviders>
        </CachedUserProvider>
      </body>
    </html>
  );
}

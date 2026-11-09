/**
 * 全局 Provider 聚合层。
 * 装配 React Query、项目 UI Provider、业务启动任务与 <html lang> 语言同步。
 */
"use client";

import "@/lib/i18n/config";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import AppUiProvider from "@/components/ui/AppUiProvider";
import { ThemeModeProvider } from "@/components/ui/theme-mode";
import { logout, useCurrentUser, useSessionUser } from "@/entities/user";
import { setUnauthorizedHandler, setUnauthorizedNavigationHandler } from "@/lib/api/client";
import { loadUploadFormats } from "@/lib/upload-formats";

/** 401 的登出动作来自 entities/user，由 app 层注入给 lib/api/client，避免 lib 反向依赖 entity */
function UnauthorizedHandlerRegistrar() {
  const router = useRouter();
  useEffect(() => {
    setUnauthorizedHandler(logout);
    setUnauthorizedNavigationHandler(() => router.replace("/login"));
    return () => {
      setUnauthorizedHandler(null);
      setUnauthorizedNavigationHandler(null);
    };
  }, [router]);
  return null;
}

/** 已登录后预热上传格式白名单（失败静默回落兜底值），供各上传入口同步读取。
 *  未登录不发：接口要求鉴权，未登录预热是必败请求（登录页上的 401 噪音）。 */
function UploadFormatsWarmup() {
  const user = useSessionUser();
  useEffect(() => {
    if (user) void loadUploadFormats();
  }, [user]);
  return null;
}

/** 同步当前语言到 <html lang>，随语言切换实时更新 */
function HtmlLangSync() {
  const { i18n } = useTranslation();
  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);
  return null;
}

/**
 * 同步用户主题到 <html>，并向下提供主题模式，让全局 shadcn 令牌、
 * 画布控件与 React Flow 共用一个主题来源。
 */
function ThemeModeSync({ children }: { children: ReactNode }) {
  const user = useCurrentUser();
  const theme = user?.theme === "light" ? "light" : "dark";

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("light", theme === "light");
  }, [theme]);

  return <ThemeModeProvider theme={theme}>{children}</ThemeModeProvider>;
}

function SessionProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
  }));
  useEffect(() => () => { queryClient.clear(); }, [queryClient]);
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  const userId = useSessionUser()?.id;
  return (
    <AppUiProvider>
      <UnauthorizedHandlerRegistrar />
      <UploadFormatsWarmup />
      <HtmlLangSync />
      <ThemeModeSync>
        <SessionProviders key={userId ?? "guest"}>{children}</SessionProviders>
      </ThemeModeSync>
    </AppUiProvider>
  );
}

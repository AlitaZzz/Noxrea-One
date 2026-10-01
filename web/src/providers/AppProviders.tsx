/**
 * 全局 Provider 聚合层。
 * 装配 React Query、项目 UI Provider、业务启动任务与 <html lang> 语言同步。
 */
"use client";

import "@/lib/i18n/config";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";

import AppUiProvider from "@/components/ui/AppUiProvider";
import { useAuthStore } from "@/features/auth/store";
import { setUnauthorizedHandler } from "@/lib/api/client";
import { loadUploadFormats } from "@/lib/upload-formats";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

/** 401 的登出动作属于 auth feature，由 app 层注入给 lib/api/client，避免 lib 反向依赖 feature */
function UnauthorizedHandlerRegistrar() {
  const logout = useAuthStore((s) => s.logout);
  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);
  return null;
}

/** 已登录后预热上传格式白名单（失败静默回落兜底值），供各上传入口同步读取。
 *  未登录不发：接口要求鉴权，未登录预热是必败请求（登录页上的 401 噪音）。 */
function UploadFormatsWarmup() {
  const user = useAuthStore((s) => s.user);
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

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AppUiProvider>
        <UnauthorizedHandlerRegistrar />
        <UploadFormatsWarmup />
        <HtmlLangSync />
        {children}
      </AppUiProvider>
    </QueryClientProvider>
  );
}

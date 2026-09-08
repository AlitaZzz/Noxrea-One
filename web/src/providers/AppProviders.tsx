/**
 * 全局 Provider 聚合层。
 * 统一装配 React Query 客户端、Ant Design 主题（明暗双套 token 与组件级覆写）、
 * 全局 message/notification API 注册（供 React 树外代码调用）以及 <html lang> 语言同步。
 */
"use client";

import "@/lib/i18n/config";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp, ConfigProvider } from "antd";
import { ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { getLayerPopupContainer } from "@/components/ui/modal/layer-context";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { setGlobalMessageApi } from "@/lib/global-message";
import { setGlobalNotificationApi } from "@/lib/global-notification";
import { directorTheme } from "@/styles/theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

/** 在组件内获取 message/notification API 并暴露给全局，供 api.ts 等 React 树外的代码使用 */
function MessageApiRegistrar() {
  const { message, notification } = AntApp.useApp();
  useEffect(() => {
    setGlobalMessageApi(message);
    setGlobalNotificationApi(notification);
  }, [message, notification]);
  return null;
}

function AntConfigProvider({ children }: { children: ReactNode }) {
  const themeMode = useCanvasStore((s) => s.theme);

  const isDark = themeMode === "dark";

  return (
    <ConfigProvider
      theme={directorTheme(isDark)}
      getPopupContainer={getLayerPopupContainer}
    >
      <AntApp>
        <MessageApiRegistrar />
        {children}
      </AntApp>
    </ConfigProvider>
  );
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
      <AntConfigProvider>
        <HtmlLangSync />
        {children}
      </AntConfigProvider>
    </QueryClientProvider>
  );
}

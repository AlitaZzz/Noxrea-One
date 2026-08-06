/**
 * 全局 Provider 聚合层。
 * 统一装配 React Query 客户端、Ant Design 主题（明暗双套 token 与组件级覆写）、
 * 全局 message API 注册（供 React 树外代码调用）以及 <html lang> 语言同步。
 */
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp, ConfigProvider } from "antd";
import { ReactNode, useEffect } from "react";

import { getLayerPopupContainer } from "@/components/ui/modal/layer-context";
import { setGlobalMessageApi } from "@/lib/global-message";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useI18nStore } from "@/lib/i18n/store";
import { directorTheme } from "@/styles/theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

/** 在组件内获取 message API 并暴露给全局，供 api.ts 等 React 树外的代码使用 */
function MessageApiRegistrar() {
  const { message } = AntApp.useApp();
  useEffect(() => { setGlobalMessageApi(message); }, [message]);
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
  const lang = useI18nStore((s) => s.lang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
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

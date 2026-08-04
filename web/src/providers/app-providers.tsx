"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp,ConfigProvider, theme as antTheme } from "antd";
import { ReactNode, useEffect } from "react";

import { setGlobalMessageApi } from "@/components/overlays/global-message";
import { getLayerPopupContainer } from "@/components/overlays/layer";
import { useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";

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
      theme={{
        algorithm:
          isDark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
        token: isDark ? {
          // Director 配色
          colorPrimary: "#3b82f6",
          borderRadius: 8,
          colorBgLayout: "#000000",
          colorBgContainer: "#0e0e11",
          colorBgElevated: "#1a1a1e",
          colorBgSpotlight: "#1a1a1e",
          colorBorder: "#2c2c31",
          colorBorderSecondary: "#232327",
          colorText: "#ececf0",
          colorTextSecondary: "#7d7d86",
          colorTextTertiary: "#56565d",
          colorTextQuaternary: "#3a3a40",
          controlOutlineWidth: 0,
        } : {
          colorPrimary: "#1677ff",
          borderRadius: 6,
          colorBgElevated: "#ffffff",
          colorBgContainer: "#ffffff",
          colorBgLayout: "#f8f9fa",
          colorBorder: "#d9d9d9",
        },
        components: {
          Select: {
            colorBgContainer: isDark ? "#1a1a1e" : "#ffffff",
            activeBorderColor: isDark ? "#2c2c31" : "#d9d9d9",
            hoverBorderColor: isDark ? "#2c2c31" : "#d9d9d9",
            activeOutlineColor: "transparent",
          },
          Slider: isDark ? {
            trackBg: "#fff",
            trackHoverBg: "#fff",
            railBg: "#1a1a1e",
            railHoverBg: "#1a1a1e",
            handleColor: "#fff",
            handleActiveColor: "#fff",
            dotActiveBorderColor: "#fff",
            handleSizeHover: 10,
            handleSize: 10,
            railSize: 2,
          } : {},
          Segmented: isDark ? {
            trackBg: "#232327",
            itemSelectedBg: "#232327",
            itemSelectedColor: "#fff",
          } : {},
          Switch: isDark ? {
            handleBg: "#000",
            colorPrimary: "#fff",
            colorPrimaryHover: "#fff",
          } : {},
          Checkbox: isDark ? {
            colorPrimary: "#ffffff",
            colorPrimaryHover: "#e6e6e6",
            colorWhite: "#1a1a1e",
          } : {},
        },
      }}
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

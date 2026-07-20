"use client";

import { ReactNode, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider, theme as antTheme, App as AntApp } from "antd";
import { useCanvasStore } from "@/stores/canvas-store";
import { getLayerPopupContainer } from "@/lib/layer";
import { setGlobalMessageApi } from "@/lib/global-message";

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

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AntConfigProvider>{children}</AntConfigProvider>
    </QueryClientProvider>
  );
}

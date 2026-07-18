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
        token: {
          colorPrimary: "#1677ff",
          borderRadius: 6,
          colorBgElevated: isDark ? "#2e2e2e" : "#ffffff",
          colorBgContainer: isDark ? "#2e2e2e" : "#ffffff",
          colorBgLayout: isDark ? "#0d0d0d" : "#f8f9fa",
          controlOutlineWidth: 0,
          lineWidthFocus: 0,
          colorBorder: isDark ? "#3a3a3a" : "#d9d9d9",
        },
        components: {
          Select: {
            activeBorderColor: isDark ? "#3a3a3a" : "#d9d9d9",
            hoverBorderColor: isDark ? "#3a3a3a" : "#d9d9d9",
            activeOutlineColor: "transparent",
          },
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

/**
 * 应用页面外壳容器。
 * 提供满屏 flex 布局骨架，并把当前主题写入 <html data-theme>，驱动 CSS 变量换肤。
 */
"use client";

import { ReactNode, useEffect } from "react";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

export default function AppShell({ children }: { children: ReactNode }) {
  const theme = useCanvasStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <div
      className="flex flex-col h-screen w-screen overflow-hidden"
      style={{
        background: "var(--canvas-app-bg)",
        color: "var(--canvas-text)",
      }}
    >
      {/* Canvas area */}
      <main className="flex-1 relative overflow-hidden">{children}</main>
    </div>
  );
}

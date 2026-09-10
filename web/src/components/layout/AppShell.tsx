/**
 * 应用页面外壳容器。
 * 提供满屏 flex 布局骨架，并固定 <html data-theme> 为深色主题。
 */
"use client";

import { ReactNode, useEffect } from "react";


export default function AppShell({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  }, []);

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

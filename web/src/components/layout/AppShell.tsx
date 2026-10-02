/**
 * 应用页面外壳容器。
 * 提供满屏 flex 布局骨架。主题由根布局的 .dark class 统一控制。
 */
"use client";

import { ReactNode } from "react";


export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col h-screen w-screen overflow-hidden"
      style={{
        background: "var(--background)",
        color: "var(--foreground)",
      }}
    >
      {/* Canvas area */}
      <main className="flex-1 relative overflow-hidden">{children}</main>
    </div>
  );
}

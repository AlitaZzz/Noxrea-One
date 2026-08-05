/**
 * Next.js 应用根布局（Root Layout）。
 * 定义 <html>/<body> 骨架、站点 metadata，并挂载全局 Provider 树。
 * 不含任何业务逻辑，仅做最外层装配。
 */
import "./globals.css";

import type { Metadata } from "next";

import { AppProviders } from "@/providers/app-providers";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Noxrea Canvas";

export const metadata: Metadata = {
  title: APP_NAME,
  description: "AI-powered infinite canvas workspace",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const initialLang = "zh";
  return (
    <html lang={initialLang} suppressHydrationWarning>
      <body className="m-0 p-0 overflow-hidden">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}

import "./globals.css";

import type { Metadata } from "next";

import { AppProviders } from "@/providers/app-providers";

export const metadata: Metadata = {
  title: "Noxrea Canvas — Infinite AI Canvas",
  description: "AI-powered infinite canvas workspace",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="m-0 p-0 overflow-hidden">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}

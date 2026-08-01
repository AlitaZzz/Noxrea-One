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

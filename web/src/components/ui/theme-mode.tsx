"use client";

import { createContext, type ReactNode, useContext } from "react";

type ThemeMode = "light" | "dark";

const ThemeModeContext = createContext<ThemeMode>("dark");

/**
 * 主题模式的唯一读取点。主题来源（用户设置）由 app 层解析后写入，
 * 业务层（如画布需要给 React Flow 传 colorMode）只消费，不反向依赖 auth。
 */
export function ThemeModeProvider({
  theme,
  children,
}: {
  theme: ThemeMode;
  children: ReactNode;
}) {
  return <ThemeModeContext.Provider value={theme}>{children}</ThemeModeContext.Provider>;
}

export function useThemeMode(): ThemeMode {
  return useContext(ThemeModeContext);
}

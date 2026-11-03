/**
 * 轨道中央的状态提示：黑底白字，明暗主题下压在画面上都有稳定对比度。
 */
"use client";

import type { ReactNode } from "react";

export function TrackNotice({ children }: { children: ReactNode }) {
  return <span className="rounded-md bg-black/65 px-3 py-1 text-xs text-white/85">{children}</span>;
}

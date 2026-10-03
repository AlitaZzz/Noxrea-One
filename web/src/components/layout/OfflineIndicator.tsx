/**
 * 画布右上角离线状态指示器。
 * 断网时显示在 Agent 按钮左侧，琥珀色圆点 + 「网络异常」文案；
 * 网络恢复后自动消失，纯展示，无需手动重试。
 */
"use client";

import { useTranslation } from "react-i18next";

import { useOnlineStatus } from "@/hooks/use-online-status";

export default function OfflineIndicator() {
  const { t } = useTranslation();
  const online = useOnlineStatus();

  if (online) return null;

  // 不加 tooltip：胶囊上已写明「网络异常，离线待保存」，此组件纯展示、无需用户重试，
  // 旧版提示「请检查网络连接后重试」反而给了错误指引。
  return (
    <div
      role="status"
      aria-label={t("offline.label")}
      className="flex h-8 select-none items-center gap-2 rounded-md border border-border bg-card px-3 text-xs text-foreground transition-colors"
    >
      <span data-testid="sync-status-dot" className="rounded-full size-2 bg-amber-400" aria-hidden="true" />
      <span>{t("offline.label")}</span>
    </div>
  );
}

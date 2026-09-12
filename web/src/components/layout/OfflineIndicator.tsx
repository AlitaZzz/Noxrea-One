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
      className="flex items-center gap-2 border-[0.5px] px-3 text-[12px] transition-colors h-8 rounded-lg select-none"
      style={{
        color: "var(--canvas-text)",
        backgroundColor: "var(--canvas-bg)",
        borderColor: "var(--canvas-border)",
      }}
    >
      <span data-testid="sync-status-dot" className="rounded-full size-2 bg-amber-400" aria-hidden="true" />
      <span>{t("offline.label")}</span>
    </div>
  );
}

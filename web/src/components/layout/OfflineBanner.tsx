/**
 * 顶部离线横幅。
 * 断网时固定在视口顶部提示，恢复在线自动消失。
 * 不占用布局空间（fixed），避免推挤画布等全屏页面。
 */
"use client";

import { useTranslation } from "react-i18next";

import { useOnlineStatus } from "@/hooks/use-online-status";

export default function OfflineBanner() {
  const { t } = useTranslation();
  const online = useOnlineStatus();

  if (online) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[1000] flex items-center justify-center px-4 py-1.5 text-xs"
      style={{ background: "#e5484d", color: "#fff" }}
      role="alert"
    >
      {t("offline.banner")}
    </div>
  );
}

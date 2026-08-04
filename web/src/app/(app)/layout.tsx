"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useAuthStore } from "@/stores/auth-store";
import { useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";
import { useProjectStore } from "@/stores/project-store";

/**
 * (app) 路由组统一鉴权 + 全局初始化守卫。
 * 所有需要登录的应用内页面（canvas / project 等）都挂载于此，
 * 避免在每个页面中重复手写 window.location.href 跳转与初始化逻辑。
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [projectsReady, setProjectsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      await useAuthStore.getState().initialize();
      if (cancelled) return;

      const user = useAuthStore.getState().user;
      if (!user) {
        router.replace("/login");
        return;
      }

      // 同步用户偏好（主题 / 语言）到全局 store
      useCanvasStore.getState().setTheme(user.theme === "light" ? "light" : "dark");
      useI18nStore.getState().setLang((user.language || "zh") as "zh" | "en");

      await useProjectStore.getState().initialize();
      if (!cancelled) {
        setProjectsReady(true);
        setAuthChecked(true);
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!authChecked) {
    return (
      <div className="flex items-center justify-center h-screen w-screen bg-[#0d0d0d] text-white">
        <div className="text-lg">Loading…</div>
      </div>
    );
  }

  return <>{children}</>;
}

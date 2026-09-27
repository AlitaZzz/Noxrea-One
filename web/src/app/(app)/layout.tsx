/**
 * (app) 路由组布局：全局后台初始化。
 * 路由级鉴权已由 proxy.ts（Next 16 的 middleware，token cookie）在服务端完成，这里不设门：
 * 会话恢复（/me）、主题 / 语言在后台初始化，不阻塞首帧。
 * token 失效由 401 全局拦截器统一提示并跳登录。
 * 项目列表不在此初始化：唯一消费方是 /project 门页，由页面挂载时自行拉取，
 * 画布页只需 GET /:id 单项目（避免全量列表随每个 (app) 路由加载）。
 */
"use client";

import { useEffect } from "react";

import { useAuthStore } from "@/features/auth/store";
import { setAppLanguage } from "@/lib/i18n/config";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      await useAuthStore.getState().initialize();
      if (cancelled) return;
      const user = useAuthStore.getState().user;
      // 取不到用户不在此跳转：token 失效走 401 拦截器，网络故障由页面自行降级
      if (!user) return;
      // 账号语言是权威值：登录后覆盖本地 cookie 记录，下次进站首帧即对
      setAppLanguage(user.language === "en" ? "en" : "zh");
    };
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  return <>{children}</>;
}

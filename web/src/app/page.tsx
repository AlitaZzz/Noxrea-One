/**
 * 站点根路由 "/" 的入口页，仅承担登录态分流。
 * 初始化 auth store 后：已登录跳 /project，未登录跳 /login，自身不渲染任何 UI。
 */
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuthStore } from "@/features/auth/store";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    useAuthStore.getState().initialize().then(() => {
      router.replace(useAuthStore.getState().user ? "/project" : "/login");
    });
  }, [router]);
  return null;
}


"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuthStore } from "@/stores/auth-store";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    useAuthStore.getState().initialize().then(() => {
      router.replace(useAuthStore.getState().user ? "/project" : "/login");
    });
  }, [router]);
  return null;
}


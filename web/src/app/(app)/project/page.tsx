/**
 * 项目列表页路由壳（/project）。
 * 客户端组合根：UI 与数据逻辑在 features/project/components/ProjectListPage，
 * 画布保存的 flush 能力由本层注入（features/project 不导入 canvas）。
 */
"use client";

import AppShell from "@/components/layout/AppShell";
import { SettingsModal, UserMenuPopover } from "@/features/auth";
import { flushCanvasSave } from "@/features/canvas";
import { ProjectListPage } from "@/features/project";

export default function ProjectPage() {
  return (
    <AppShell>
      <ProjectListPage
        flushPendingCanvasSaves={flushCanvasSave}
        accountMenu={UserMenuPopover}
        accountSettings={SettingsModal}
      />
    </AppShell>
  );
}

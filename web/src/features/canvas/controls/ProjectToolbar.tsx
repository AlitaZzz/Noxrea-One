/**
 * 画布左上角项目工具栏（常驻 Panel 内容）。
 * 菜单开合与项目名编辑是局部交互状态，内聚在此；用户菜单由页面插槽注入，
 * 项目菜单条目与动作也归页面（本组件只提供触发器）。
 */
import { memo, type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChevronDownIcon, EditOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  renameProject,
  useActiveProjectId,
  useActiveProjectSummary,
} from "@/entities/project";
import type { CanvasSlots } from "@/features/canvas/root/contracts";

export interface ProjectToolbarProps {
  /** 页面注入的用户菜单；触发器与开合状态由本组件提供。 */
  userMenu: CanvasSlots["userMenu"];
  /** 标题后的常驻尾部内容（保存状态）；由左上区域注入，工具栏不感知其状态。 */
  trailing: ReactNode;
}

const ProjectToolbar = memo(function ProjectToolbar({ userMenu, trailing }: ProjectToolbarProps) {
  const { t } = useTranslation();
  const activeProjectId = useActiveProjectId();
  const projectName = useActiveProjectSummary()?.name ?? "";
  const [menuOpen, setMenuOpen] = useState(false);
  const [editName, setEditName] = useState(projectName);
  const [isEditingName, setIsEditingName] = useState(false);
  const [prevProjectName, setPrevProjectName] = useState(projectName);
  if (projectName !== prevProjectName) {
    setPrevProjectName(projectName);
    setEditName(projectName);
  }

  const menuTrigger = useMemo(
    () => (
      <Button type="button" variant="ghost" size="sm" aria-label={t("auth.accountSettings")} className="h-7 shrink-0 gap-1 rounded px-1">
        <img src="/favicon.ico" alt="Noxrea" style={{ width: 24, height: 24 }} />
        <ChevronDownIcon
          className="shrink-0 transition-transform duration-200"
          style={{ width: 10, height: 10, transform: menuOpen ? "rotate(180deg)" : "none" }}
        />
      </Button>
    ),
    [t, menuOpen],
  );

  return (
    // 320px 下卡片触达 min-w 下限，收紧水平内边距为完整状态文字留出空间
    <Card className="pointer-events-auto flex h-9 w-fit min-w-[280px] max-w-[calc(100vw-42px)] flex-row items-center gap-1 overflow-hidden rounded-lg border-border bg-card/70 px-2 py-0 backdrop-blur-[10px] max-[340px]:px-1.5">
      {userMenu({ trigger: menuTrigger, open: menuOpen, onOpenChange: setMenuOpen })}
      <Separator orientation="vertical" className="mx-0.5 h-5" />
      <div className="@container/name flex w-40 min-w-0 shrink items-center">
        {isEditingName ? (
          <Input
            className="bg-transparent text-sm outline-none border-none flex-1 min-w-0"
            style={{ height: 24, cursor: "text" }}
            placeholder={t("project.untitled")}
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onFocus={(e) => e.target.setSelectionRange(0, e.target.value.length)}
            onBlur={() => {
              setIsEditingName(false);
              if (activeProjectId && editName.trim()) {
                renameProject(activeProjectId, editName.trim());
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") { setIsEditingName(false); setEditName(projectName); }
            }}
          />
        ) : (
          /* 编辑入口对齐节点标题：双击文字或点悬停铅笔（样式见 NodeTitle） */
          <div className="group/name flex h-6 min-w-0 flex-1 items-center">
            <div
              className="h-6 min-w-0 cursor-default select-none truncate text-sm leading-6 text-foreground"
              onDoubleClick={() => setIsEditingName(true)}
            >
              {editName || "Untitled"}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("common.edit")}
              className="ml-1.5 hidden shrink-0 opacity-0 transition-opacity group-hover/name:opacity-100 focus-visible:opacity-100 @[6rem]/name:inline-flex"
              onClick={() => setIsEditingName(true)}
            >
              <EditOutlined />
            </Button>
          </div>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center">{trailing}</div>
    </Card>
  );
});

export default ProjectToolbar;

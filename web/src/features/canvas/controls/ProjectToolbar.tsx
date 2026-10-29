/**
 * 画布左上角项目工具栏（常驻 Panel 内容）。
 * 菜单开合与项目名编辑是局部交互状态，内聚在此；props 全部为稳定引用/原语，
 * 画布外壳在程序化位置帧逐帧重渲染时本组件直接 bail。
 */
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChevronDownIcon, EditOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { type UserMenuItem, UserMenuPopover } from "@/features/auth/components/UserMenuPopover";
import { useProjectStore } from "@/features/project/store";

export interface ProjectToolbarProps {
  projectName: string;
  items: UserMenuItem[];
  onItemClick: (key: string) => void;
  onLogout: () => void;
}

const ProjectToolbar = memo(function ProjectToolbar({
  projectName,
  items,
  onItemClick,
  onLogout,
}: ProjectToolbarProps) {
  const { t } = useTranslation();
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
    <div style={{ paddingLeft: 30, paddingTop: 30 }}>
      <Card className="pointer-events-auto flex h-9 w-[280px] shrink-0 flex-row items-center gap-1 rounded-lg border-border bg-card/70 px-2 py-0 backdrop-blur-[10px]">
        <UserMenuPopover
          open={menuOpen}
          onOpenChange={setMenuOpen}
          placement="bottomLeft"
          items={items}
          onItemClick={onItemClick}
          onLogout={onLogout}
          trigger={menuTrigger}
        />
        <Separator orientation="vertical" className="mx-0.5 h-5" />
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
              const activeId = useProjectStore.getState().activeProjectId;
              if (activeId && editName.trim()) {
                useProjectStore.getState().renameProject(activeId, editName.trim());
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
              className="ml-1.5 shrink-0 opacity-0 transition-opacity group-hover/name:opacity-100 focus-visible:opacity-100"
              onClick={() => setIsEditingName(true)}
            >
              <EditOutlined />
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
});

export default ProjectToolbar;

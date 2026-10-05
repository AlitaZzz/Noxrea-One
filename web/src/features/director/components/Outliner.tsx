/**
 * 3D 导演台左侧场景大纲。
 * 树形列出场景中的实体与镜头，支持搜索、重命名、显隐切换、多选与删除。
 */

"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CopyOutlined, DeleteOutlined } from "@/components/ui/AppIcon";
import { DirCameraIcon } from "@/components/ui/AppIcon";
import { DirCaretIcon } from "@/components/ui/AppIcon";
import { DirCubeIcon } from "@/components/ui/AppIcon";
import { DirEyeIcon } from "@/components/ui/AppIcon";
import { DirEyeOffIcon } from "@/components/ui/AppIcon";
import { DirGroupIcon } from "@/components/ui/AppIcon";
import { DirPersonIcon } from "@/components/ui/AppIcon";
import { DirTrashIcon } from "@/components/ui/AppIcon";
import { UngroupIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SearchInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDirectorStore } from "@/features/director/director-store";
import type { Entity } from "@/features/director/entities/entity";

const ICON_MAP = {
  camera: DirCameraIcon,
  person: DirPersonIcon,
  cube: DirCubeIcon,
  group: DirGroupIcon,
  caret: DirCaretIcon,
  eye: DirEyeIcon,
  eyeOff: DirEyeOffIcon,
};
const S = (name: string) => {
  const C = ICON_MAP[name as keyof typeof ICON_MAP];
  return C ? <C /> : null;
};

export default function Outliner() {
  const { t } = useTranslation();
  const entities = useDirectorStore((s) => s.entities);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const selectedIds = useDirectorStore((s) => s.selectedIds);
  const runtime = useDirectorStore((s) => s.runtime);
  const allShots = useDirectorStore((s) => s.shots);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const matches = (name: string) => !search || name.toLowerCase().includes(search.toLowerCase());
  const typeIcon = (type: string) => type === "character" ? "person" : type === "camera" ? "camera" : type === "crowd" ? "group" : "cube";
  const filtered = search ? entities.filter((e) => matches(e.name)) : entities;

  return (
    <div className="flex flex-col h-full">
      {/* 搜索框 */}
      <div className="mb-[14px]">
        <SearchInput
          placeholder={t("director.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          clearable
          onClear={() => setSearch("")}
          containerClassName="border-transparent bg-muted text-foreground"
        />
      </div>

      {/* 树 */}
      <div className="dir-outliner-list flex flex-1 select-none flex-col gap-0.5">
        {filtered.length === 0 && (
          <div className="px-1.5 py-[22px] text-center text-xs text-muted-foreground">{t("director.emptyScene")}</div>
        )}
        {filtered.map((ent) => {
          const sel = selectedIds.includes(ent.id);
          const isCrowd = ent.type === "crowd";
          const open = !collapsed.has(ent.id);
          const isCamera = ent.type === "camera";
          const shotCount = isCamera ? allShots.filter((s) => s.cameraId === ent.id).length : 0;

          const contextIds = selectedIds.includes(ent.id) ? selectedIds : [ent.id];
          const contextGroupCount = contextIds.filter((id) => entities.find((x) => x.id === id)?.type === "character").length;
          const selectEntity = () => {
            if (ent.type === "camera") {
              runtime?.select(ent.id);
              runtime?.setCameraView(true);
            } else {
              runtime?.setCameraView(false);
              runtime?.select(ent.id);
            }
          };

          return (
            <div key={ent.id}>
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    {/* 主行：选择动作使用标准 Button，外层仅负责布局和右键菜单。 */}
                    <div
                      className="group/item flex items-center gap-0.5"
                      onContextMenu={() => {
                        if (!selectedIds.includes(ent.id)) runtime?.select(ent.id);
                      }}
                    >
                      {/* 折叠控制与选择动作并列，避免可点击元素嵌套在选择按钮内。 */}
                      {isCrowd && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={open ? t("common.collapse") : t("common.expand")}
                          aria-expanded={open}
                          className="mr-[-2px] shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                          onClick={() => {
                            setCollapsed((c) => {
                              const next = new Set(c);
                              if (open) next.add(ent.id);
                              else next.delete(ent.id);
                              return next;
                            });
                          }}
                        >
                          <span className={`transition-transform ${open ? "rotate-90" : ""}`}>{S("caret")}</span>
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        aria-pressed={sel}
                        className={`h-auto min-w-0 flex-1 justify-start gap-[9px] rounded-lg px-2.5 py-[9px] text-[13px]
                        ${sel ? "bg-accent text-accent-foreground hover:bg-accent" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                        onClick={(e) => {
                          if (e.shiftKey) {
                            runtime?.toggleSelect(ent.id); return;
                          }
                          selectEntity();
                        }}
                      >
                        <span className="flex w-[18px] items-center">{S(typeIcon(ent.type))}</span>
                        <span className="flex-1 truncate">{ent.name}</span>
                        {isCamera && shotCount > 0 && (
                          <span className="min-w-[18px] shrink-0 rounded-full bg-secondary px-[5px] text-center text-[10px] font-semibold leading-[18px] text-secondary-foreground">{shotCount}</span>
                        )}
                      </Button>

                      {/* 操作按钮(hover/选中时显示) */}
                      <span className={`gap-0.5 ${sel ? "flex" : "hidden group-hover/item:flex"}`}>
                      {isCrowd && (
                        <Tooltip><TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={t("director.ungroup")}
                              className="text-muted-foreground hover:bg-transparent hover:text-foreground"
                              onClick={(e) => { e.stopPropagation(); runtime?.ungroupCrowd(ent.id); }}
                            >
                              <UngroupIcon />
                            </Button>
                          </TooltipTrigger><TooltipContent>{t("director.ungroup")}</TooltipContent></Tooltip>
                      )}
                      <Button type="button" variant="ghost" size="icon-xs"
                        className="text-muted-foreground hover:bg-transparent hover:text-foreground"
                        onClick={(e) => { e.stopPropagation(); runtime?.toggleVisible(ent.id); }} ><span className="w-[14px] flex items-center">{ent.visible ? S("eye") : S("eyeOff")}</span></Button>
                      <Button type="button" variant="ghost" size="icon-xs"
                        className="text-muted-foreground hover:bg-transparent hover:text-foreground"
                        onClick={(e) => { e.stopPropagation(); runtime?.remove(ent.id); }} ><DeleteOutlined /></Button>
                      </span>
                    </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-[184px]">
                  <ContextMenuItem
                    onSelect={() => runtime?.groupCharacters(contextIds)}
                    disabled={contextGroupCount < 2}
                  >
                    <span className="w-[18px] flex items-center justify-center text-muted-foreground"><DirGroupIcon /></span>
                    <span className="flex-1">{t("director.group")}</span>
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => runtime?.toggleVisibleMany(contextIds)}>
                    <span className="w-[18px] flex items-center justify-center text-muted-foreground"><DirEyeIcon /></span>
                    <span className="flex-1">{t("director.toggleVisible")}</span>
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => runtime?.duplicateMany(contextIds)}>
                    <span className="w-[18px] flex items-center justify-center text-muted-foreground"><CopyOutlined /></span>
                    <span className="flex-1">{t("director.duplicate")}</span>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onSelect={() => contextIds.forEach((id) => runtime?.remove(id))}>
                    <span className="w-[18px] flex items-center justify-center"><DirTrashIcon /></span>
                    <span className="flex-1">{t("common.delete")}</span>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>

              {/* 群众成员(展开) */}
              {isCrowd && open && (ent as unknown as { _members?: Entity[] })._members?.map((m: Entity) => {
                const mIsCamera = m.type === "camera";
                const mShotCount = mIsCamera ? allShots.filter((s) => s.cameraId === m.id).length : 0;
                return (
                <Button
                  key={m.id}
                  type="button"
                  variant="ghost"
                  aria-pressed={selectedId === m.id}
                  className={`h-auto w-full justify-start gap-[9px] rounded-lg px-2.5 py-[9px] pl-[30px] text-[13px]
                  ${selectedId === m.id ? "bg-accent text-accent-foreground hover:bg-accent" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (mIsCamera) { runtime?.select(m.id); runtime?.setCameraView(true); }
                    else { runtime?.setCameraView(false); runtime?.select(m.id); }
                  }}
                >
                  <span className="w-[18px] flex items-center">{S(typeIcon(m.type))}</span>
                  <span className="flex-1 truncate">{m.name}</span>
                  {mIsCamera && mShotCount > 0 && (
                    <span className="min-w-[18px] shrink-0 rounded-full bg-secondary px-[5px] text-center text-[10px] font-semibold leading-[18px] text-secondary-foreground">{mShotCount}</span>
                  )}
                </Button>
                );
              })}
            </div>
          );
        })}
      </div>

    </div>
  );
}

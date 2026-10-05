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
  trash: DirTrashIcon,
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
          containerClassName="border-transparent bg-[var(--dir-panel2)] text-[var(--dir-txt)]"
        />
      </div>

      {/* 树 */}
      <div className="dir-outliner-list flex flex-1 select-none flex-col gap-0.5">
        {filtered.length === 0 && (
          <div className="px-1.5 py-[22px] text-center text-xs text-[var(--dir-dim2)]">{t("director.emptyScene")}</div>
        )}
        {filtered.map((ent) => {
          const sel = selectedIds.includes(ent.id);
          const isCrowd = ent.type === "crowd";
          const open = !collapsed.has(ent.id);
          const isCamera = ent.type === "camera";
          const shotCount = isCamera ? allShots.filter((s) => s.cameraId === ent.id).length : 0;

          const contextIds = selectedIds.includes(ent.id) ? selectedIds : [ent.id];
          const contextGroupCount = contextIds.filter((id) => entities.find((x) => x.id === id)?.type === "character").length;

          return (
            <div key={ent.id}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  {/* 主行 */}
                  <div className={`flex cursor-pointer items-center gap-[9px] rounded-lg px-2.5 py-[9px] text-[13px] transition-colors
                ${sel ? "bg-[var(--dir-panel3)] text-[var(--dir-txt)]" : "text-[var(--dir-dim)] hover:bg-[var(--dir-panel2)] hover:text-[var(--dir-txt)]"}`}
                onClick={(e) => {
                  if (e.shiftKey) {
                    runtime?.toggleSelect(ent.id); return;
                  }
                  if (ent.type === "camera") {
                    runtime?.select(ent.id);
                    runtime?.setCameraView(true);
                  } else {
                    runtime?.setCameraView(false);
                    runtime?.select(ent.id);
                  }
                }}
                onContextMenu={() => {
                  if (!selectedIds.includes(ent.id)) runtime?.select(ent.id);
                }}
                  >
                {/* 群众折叠箭头 */}
                {isCrowd && (
                  <span className={`mr-[-2px] flex w-[14px] cursor-pointer items-center text-[var(--dir-dim)] transition-transform ${open ? "rotate-90" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCollapsed((c) => {
                        const next = new Set(c);
                        if (open) next.add(ent.id);
                        else next.delete(ent.id);
                        return next;
                      });
                    }}
                  >
                    {S("caret")}
                  </span>
                )}
                <span className="w-[18px] flex items-center">{S(typeIcon(ent.type))}</span>
                <span className="flex-1 truncate">{ent.name}</span>
                {isCamera && shotCount > 0 && (
                  <span className="min-w-[18px] shrink-0 rounded-full bg-[var(--dir-accent)] px-[5px] text-center text-[10px] font-semibold leading-[18px] text-white">{shotCount}</span>
                )}
                {/* 操作按钮(hover/选中时显示) */}
                <span className={`gap-0.5 ${sel ? "flex" : "hidden"} group-hover/item:flex`} style={{ display: sel ? "flex" : undefined }}>
                  {(isCrowd || true) && (
                    <>
                      {isCrowd && (
                        <Tooltip><TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={t("director.ungroup")}
                              className="text-[var(--dir-dim)] hover:bg-transparent hover:text-[var(--dir-txt)]"
                              onClick={(e) => { e.stopPropagation(); runtime?.ungroupCrowd(ent.id); }}
                            >
                              <UngroupIcon />
                            </Button>
                          </TooltipTrigger><TooltipContent>{t("director.ungroup")}</TooltipContent></Tooltip>
                      )}
                      <Button variant="ghost" size="icon-xs"
                        className="text-[var(--dir-dim)] hover:bg-transparent hover:text-[var(--dir-txt)]"
                        onClick={(e) => { e.stopPropagation(); runtime?.toggleVisible(ent.id); }} ><span className="w-[14px] flex items-center">{ent.visible ? S("eye") : S("eyeOff")}</span></Button>
                      <Button variant="ghost" size="icon-xs"
                        className="text-[var(--dir-dim)] hover:bg-transparent hover:text-[var(--dir-txt)]"
                        onClick={(e) => { e.stopPropagation(); runtime?.remove(ent.id); }} ><DeleteOutlined /></Button>
                    </>
                  )}
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
                <div key={m.id} className={`flex cursor-pointer items-center gap-[9px] rounded-lg px-2.5 py-[9px] pl-[30px] text-[13px] transition-colors
                  ${selectedId === m.id ? "bg-[var(--dir-panel3)] text-[var(--dir-txt)]" : "text-[var(--dir-dim)] hover:bg-[var(--dir-panel2)] hover:text-[var(--dir-txt)]"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (mIsCamera) { runtime?.select(m.id); runtime?.setCameraView(true); }
                    else { runtime?.setCameraView(false); runtime?.select(m.id); }
                  }}
                >
                  <span className="w-[18px] flex items-center">{S(typeIcon(m.type))}</span>
                  <span className="flex-1 truncate">{m.name}</span>
                  {mIsCamera && mShotCount > 0 && (
                    <span className="min-w-[18px] shrink-0 rounded-full bg-[var(--dir-accent)] px-[5px] text-center text-[10px] font-semibold leading-[18px] text-white">{mShotCount}</span>
                  )}
                </div>
                );
              })}
            </div>
          );
        })}
      </div>

    </div>
  );
}

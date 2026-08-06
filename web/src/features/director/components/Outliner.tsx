/**
 * 3D 导演台左侧场景大纲。
 * 树形列出场景中的实体与镜头，支持搜索、重命名、显隐切换、多选与删除。
 */
"use client";

import { DeleteOutlined } from "@ant-design/icons";
import { Button,Input } from "antd";
import { useEffect, useRef,useState } from "react";
import { createPortal } from "react-dom";

import { useDirectorStore } from "@/features/director/director-store";
import type { Entity } from "@/features/director/entities/entity";
import { DirCameraIcon } from "@/components/ui/icons/director/DirCameraIcon";
import { DirCaretIcon } from "@/components/ui/icons/director/DirCaretIcon";
import { DirCubeIcon } from "@/components/ui/icons/director/DirCubeIcon";
import { DirEyeIcon } from "@/components/ui/icons/director/DirEyeIcon";
import { DirEyeOffIcon } from "@/components/ui/icons/director/DirEyeOffIcon";
import { DirGroupIcon } from "@/components/ui/icons/director/DirGroupIcon";
import { DirPersonIcon } from "@/components/ui/icons/director/DirPersonIcon";
import { DirTrashIcon } from "@/components/ui/icons/director/DirTrashIcon";

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
  const entities = useDirectorStore((s) => s.entities);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const selectedIds = useDirectorStore((s) => s.selectedIds);
  const runtime = useDirectorStore((s) => s.runtime);
  const allShots = useDirectorStore((s) => s.shots);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: Event) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) return; // 点菜单内部不关
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCtxMenu(null); };
    const id = setTimeout(() => {
      window.addEventListener("pointerdown", close, true);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const matches = (name: string) => !search || name.toLowerCase().includes(search.toLowerCase());
  const typeIcon = (type: string) => type === "character" ? "person" : type === "camera" ? "camera" : type === "crowd" ? "group" : "cube";
  const filtered = search ? entities.filter((e) => matches(e.name)) : entities;
  const ctxGroupCount = ctxMenu?.ids.filter((id) => { const t = entities.find((x) => x.id === id)?.type; return t === "character" || t === "camera" || t === "prop"; }).length || 0;

  return (
    <div className="flex flex-col h-full">
      {/* 搜索框 */}
      <div className="mb-[14px]">
        <Input allowClear size="small" placeholder="搜索..."
          className="searchbox-input"
          style={{ background: "var(--dir-panel2)", border: "1px solid transparent", borderRadius: 9, color: "var(--dir-txt)", fontSize: 13, padding: "9px 12px" }}
          value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {/* 树 */}
      <div className="flex flex-col gap-0.5 select-none flex-1 dir-outliner-list">
        {filtered.length === 0 && (
          <div className="text-center text-xs py-[22px] px-1.5" style={{ color: "var(--dir-dim2)" }}>场景为空</div>
        )}
        {filtered.map((ent) => {
          const sel = selectedIds.includes(ent.id);
          const isCrowd = ent.type === "crowd";
          const open = !collapsed.has(ent.id);
          const isCamera = ent.type === "camera";
          const shotCount = isCamera ? allShots.filter((s) => s.cameraId === ent.id).length : 0;

          return (
            <div key={ent.id}>
              {/* 主行 */}
              <div className={`flex items-center gap-[9px] rounded-lg cursor-pointer text-[13px] transition-colors
                ${sel ? "bg-[var(--dir-panel3)] text-[var(--dir-txt)]" : "text-[var(--dir-dim)] hover:bg-[var(--dir-panel2)] hover:text-[var(--dir-txt)]"}`}
                style={{ padding: "9px 10px" }}
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  const ids = selectedIds.includes(ent.id) ? selectedIds : [ent.id];
                  if (!selectedIds.includes(ent.id)) runtime?.select(ent.id);
                  setCtxMenu({ x: e.clientX, y: e.clientY, ids });
                }}
              >
                {/* 群众折叠箭头 */}
                {isCrowd && (
                  <span className={`w-[14px] flex items-center cursor-pointer mr-[-2px] transition-transform ${open ? "rotate-90" : ""}`}
                    style={{ color: "var(--dir-dim)" }}
                    onClick={(e) => { e.stopPropagation(); setCollapsed((c) => { const n = new Set(c); open ? n.add(ent.id) : n.delete(ent.id); return n; }); }}
                  >
                    {S("caret")}
                  </span>
                )}
                <span className="w-[18px] flex items-center">{S(typeIcon(ent.type))}</span>
                <span className="flex-1 truncate">{ent.name}</span>
                {isCamera && shotCount > 0 && (
                  <span style={{
                    minWidth: 18, height: 18, borderRadius: 9,
                    background: "var(--dir-accent)", color: "#fff",
                    fontSize: 10, fontWeight: 600, lineHeight: "18px",
                    textAlign: "center", padding: "0 5px", flexShrink: 0,
                  }}>{shotCount}</span>
                )}
                {/* 操作按钮(hover/选中时显示) */}
                <span className={`gap-0.5 ${sel ? "flex" : "hidden"} group-hover/item:flex`} style={{ display: sel ? "flex" : undefined }}>
                  {(isCrowd || true) && (
                    <>
                      {isCrowd && <button className="inline-flex items-center justify-center p-0.5 rounded bg-transparent border-0 cursor-pointer"
                        style={{ color: "var(--dir-dim)" }}
                        onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.color = "var(--dir-txt)"}
                        onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.color = "var(--dir-dim)"}
                        onClick={(e) => { e.stopPropagation(); runtime?.ungroupCrowd(ent.id); }} title="解组">⊟</button>}
                      <Button type="text" size="small"
                        icon={<span className="w-[14px] flex items-center">{ent.visible ? S("eye") : S("eyeOff")}</span>}
                        className="!p-0.5"
                        style={{ color: "var(--dir-dim)" }}
                        onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.color = "var(--dir-txt)"}
                        onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.color = "var(--dir-dim)"}
                        onClick={(e) => { e.stopPropagation(); runtime?.toggleVisible(ent.id); }} />
                      <Button type="text" size="small"
                        icon={<DeleteOutlined />}
                        className="!p-0.5"
                        style={{ color: "var(--dir-dim)" }}
                        onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.color = "var(--dir-txt)"}
                        onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.color = "var(--dir-dim)"}
                        onClick={(e) => { e.stopPropagation(); runtime?.remove(ent.id); }} />
                    </>
                  )}
                </span>
              </div>

              {/* 群众成员(展开) */}
              {isCrowd && open && (ent as unknown as { _members?: Entity[] })._members?.map((m: Entity) => {
                const mIsCamera = m.type === "camera";
                const mShotCount = mIsCamera ? allShots.filter((s) => s.cameraId === m.id).length : 0;
                return (
                <div key={m.id} className={`flex items-center gap-[9px] rounded-lg cursor-pointer text-[13px] transition-colors
                  ${selectedId === m.id ? "bg-[var(--dir-panel3)] text-[var(--dir-txt)]" : "text-[var(--dir-dim)] hover:bg-[var(--dir-panel2)] hover:text-[var(--dir-txt)]"}`}
                  style={{ padding: "9px 10px", paddingLeft: 30 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (mIsCamera) { runtime?.select(m.id); runtime?.setCameraView(true); }
                    else { runtime?.setCameraView(false); runtime?.select(m.id); }
                  }}
                >
                  <span className="w-[18px] flex items-center">{S(typeIcon(m.type))}</span>
                  <span className="flex-1 truncate">{m.name}</span>
                  {mIsCamera && mShotCount > 0 && (
                    <span style={{
                      minWidth: 18, height: 18, borderRadius: 9,
                      background: "var(--dir-accent)", color: "#fff",
                      fontSize: 10, fontWeight: 600, lineHeight: "18px",
                      textAlign: "center", padding: "0 5px", flexShrink: 0,
                    }}>{mShotCount}</span>
                  )}
                </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* 右键菜单 — portal 到 body 最上层 */}
      {ctxMenu && createPortal(
        <div ref={ctxMenuRef} className="dir-ctxmenu" style={{ left: Math.min(ctxMenu.x, window.innerWidth - 200), top: Math.min(ctxMenu.y, window.innerHeight - 200), zIndex: 9999 }}>
          <button className="flex items-center gap-[13px] w-full text-left px-[13px] py-2.5 rounded-[10px] text-sm text-white cursor-pointer hover:bg-[var(--menu-item-hover)] bg-transparent border-0"
            onClick={() => { runtime?.groupCharacters(ctxMenu.ids); setCtxMenu(null); }}
            disabled={ctxGroupCount < 2} style={ctxGroupCount < 2 ? { color: "var(--dir-dim2)", cursor: "default", pointerEvents: "none" } : {}}>
            <span className="w-[18px] flex items-center justify-center" style={{ color: "var(--dir-dim)" }}>⊞</span>
            <span className="flex-1">打组</span>
          </button>
          <button className="flex items-center gap-[13px] w-full text-left px-[13px] py-2.5 rounded-[10px] text-sm text-white cursor-pointer hover:bg-[var(--menu-item-hover)] bg-transparent border-0"
            onClick={() => { runtime?.toggleVisibleMany(ctxMenu.ids); setCtxMenu(null); }}>
            <span className="w-[18px] flex items-center justify-center" style={{ color: "var(--dir-dim)" }}>{S("eye")}</span>
            <span className="flex-1">显示 / 隐藏</span>
          </button>
          <button className="flex items-center gap-[13px] w-full text-left px-[13px] py-2.5 rounded-[10px] text-sm text-white cursor-pointer hover:bg-[var(--menu-item-hover)] bg-transparent border-0"
            onClick={() => { runtime?.duplicateMany(ctxMenu.ids); setCtxMenu(null); }}>
            <span className="w-[18px] flex items-center justify-center" style={{ color: "var(--dir-dim)" }}>⧉</span>
            <span className="flex-1">创建副本</span>
          </button>
          <div className="h-px my-1.5 mx-1.5" style={{ background: "var(--dir-line2)" }} />
          <button className="flex items-center gap-[13px] w-full text-left px-[13px] py-2.5 rounded-[10px] text-sm cursor-pointer hover:bg-[var(--menu-item-hover)] bg-transparent border-0"
            style={{ color: "var(--dir-accent)" }}
            onClick={() => { ctxMenu.ids.forEach((id) => runtime?.remove(id)); setCtxMenu(null); }}>
            <span className="w-[18px] flex items-center justify-center" style={{ color: "var(--dir-dim)" }}>🗑</span>
            <span className="flex-1">删除</span>
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

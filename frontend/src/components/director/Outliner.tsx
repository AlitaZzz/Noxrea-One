"use client";

import { DeleteOutlined } from "@ant-design/icons";
import { Button,Input } from "antd";
import { useEffect, useRef,useState } from "react";
import { createPortal } from "react-dom";

import type { Entity } from "@/director/entities/entity";
import { useDirectorStore } from "@/stores/director-store";

const ICON: Record<string, string> = {
  camera: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3"/></svg>`,
  person: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="6" r="2.5"/><path d="M12 8.5c-2.2 0-3.6 1.5-3.6 3.6V15M12 8.5c2.2 0 3.6 1.5 3.6 3.6V15M9.2 21v-5M14.8 21v-5"/></svg>`,
  cube: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12v9M4 7.5l8 4.5 8-4.5"/></svg>`,
  group: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="2.1"/><circle cx="17" cy="7" r="2.1"/><circle cx="7" cy="17" r="2.1"/><circle cx="17" cy="17" r="2.1"/></svg>`,
  caret: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.8M6.1 6.1C3.5 7.7 2 12 2 12s3.5 7 10 7a9.5 9.5 0 0 0 4-0.9M3 3l18 18"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>`,
};
const S = (name: string) => ICON[name] || "";

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
                    dangerouslySetInnerHTML={{ __html: S("caret") }} />
                )}
                <span className="w-[18px] flex items-center" dangerouslySetInnerHTML={{ __html: S(typeIcon(ent.type)) }} />
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
                        icon={<span className="w-[14px] flex items-center" dangerouslySetInnerHTML={{ __html: ent.visible ? S("eye") : S("eyeOff") }} />}
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
                  <span className="w-[18px] flex items-center" dangerouslySetInnerHTML={{ __html: S(typeIcon(m.type)) }} />
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
            <span className="w-[18px] flex items-center justify-center" style={{ color: "var(--dir-dim)" }} dangerouslySetInnerHTML={{ __html: S("eye") }} />
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

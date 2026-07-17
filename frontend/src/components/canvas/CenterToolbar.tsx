"use client";

import { useState, useCallback, useEffect } from "react";
import { Popover, Tooltip } from "antd";
import {
  PlusOutlined,
  FontSizeOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  GroupOutlined,
} from "@ant-design/icons";
import { useCanvasStore, takeCanvasSnapshot, getViewportCenter } from "@/stores/canvas-store";
import { useHistoryStore } from "@/stores/history-store";
import { createTextNode, createImageNode, createVideoNode, createGroupNode } from "@/lib/node-defaults";
import { useI18nStore } from "@/stores/i18n-store";
import { MenuItem, MenuDivider } from "@/components/common/MenuPopover";

export default function CenterToolbar() {
  const t = useI18nStore((s) => s.t);
  const [open, setOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    function onContextMenu(e: Event) {
      const { x, y } = (e as CustomEvent).detail;
      setCtxMenu({ x, y });
    }
    window.addEventListener("canvas:context-menu", onContextMenu);
    return () => window.removeEventListener("canvas:context-menu", onContextMenu);
  }, []);

  const addNodes = useCanvasStore((s) => s.addNodes);
  const pushHistory = useHistoryStore((s) => s.push);

  const addNode = useCallback(
    (type: "text" | "image" | "video" | "group") => {
      pushHistory(takeCanvasSnapshot());
      const { x: cx, y: cy } = getViewportCenter();
      const pos = { x: cx - 120, y: cy - 80 };
      if (type === "text") addNodes([createTextNode(pos)]);
      else if (type === "image") addNodes([createImageNode(pos)]);
      else if (type === "video") addNodes([createVideoNode(pos)]);
      else addNodes([createGroupNode({ x: cx - 200, y: cy - 100 }, { width: 400, height: 200 })]);
      setOpen(false);
    },
    [addNodes, pushHistory]
  );

  return (
    <>
      <style>{`
        .center-add-btn.ant-btn-text {
          color: var(--canvas-text);
          width: 40px;
          height: 40px;
        }
        .center-add-btn.ant-btn-text:hover {
          background: var(--canvas-bg-hover) !important;
          color: var(--canvas-text) !important;
        }
      `}</style>
      <div
        className="flex items-center px-2 rounded-lg shadow-lg"
        style={{ height: 60, background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)" }}
      >
        <Popover
          content={
            <div className="flex flex-col p-2 gap-0.5" style={{ width: 140, margin: -16 }}>
              <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
              <MenuItem onClick={() => addNode("text")}><FontSizeOutlined /> {t("text.node")}</MenuItem>
              <MenuItem onClick={() => addNode("image")}><PictureOutlined /> {t("image.node")}</MenuItem>
              <MenuItem onClick={() => addNode("video")}><VideoCameraOutlined /> {t("video.node")}</MenuItem>
              <MenuDivider />
              <MenuItem onClick={() => addNode("group")}><GroupOutlined /> {t("group.node")}</MenuItem>
            </div>
          }
          trigger="click"
          open={open}
          onOpenChange={setOpen}
          placement="top"
          styles={{ container: { padding: 16, background: "var(--canvas-bg)", marginBottom: 28 } }}
        >
          <Tooltip title={t("add.node")}>
            <button className="center-add-btn ant-btn-text ant-btn ant-btn-sm flex items-center justify-center rounded-md border-none cursor-pointer"
              style={{ background: "transparent", color: "var(--canvas-text)", fontSize: 20 }}>
              <PlusOutlined />
            </button>
          </Tooltip>
        </Popover>

        <div className="w-px h-8 mx-1" style={{ background: "var(--canvas-border)" }} />

        <Popover
          content={
            <div style={{ width: 1100, margin: -16 }}>
              <div className="flex gap-8 text-sm" style={{ color: "var(--canvas-text-dim)", padding: "16px 20px" }}>
                {[
                  { title: t("shortcuts.zoom"), items: [["Ctrl+=", t("shortcuts.desc.zoomin")], ["Ctrl+-", t("shortcuts.desc.zoomout")], ["Ctrl+0", t("shortcuts.desc.reset")], [t("shortcuts.key.scroll"), t("shortcuts.desc.scroll")]] },
                  { title: t("shortcuts.pan"), items: [[t("shortcuts.key.drag"), t("shortcuts.desc.pan")], [t("shortcuts.key.spaceDrag"), t("shortcuts.desc.temppan")]] },
                  { title: t("shortcuts.edit"), items: [["Ctrl+C", t("shortcuts.desc.copy")], ["Ctrl+V", t("shortcuts.desc.paste")], ["Ctrl+Z", t("shortcuts.desc.undo")], ["Ctrl+Shift+Z", t("shortcuts.desc.redo")], ["Delete", t("shortcuts.desc.delete")]] },
                  { title: t("shortcuts.group"), items: [["Ctrl+G", t("shortcuts.desc.group")], ["Ctrl+Shift+G", t("shortcuts.desc.ungroup")]] },
                  { title: t("shortcuts.other"), items: [["Ctrl+A", t("shortcuts.desc.selectall")], ["Ctrl+M", t("shortcuts.desc.minimap")], [t("shortcuts.key.shiftClick"), t("shortcuts.desc.multiselect")], ["Escape", t("shortcuts.desc.esc")], ["?", t("shortcuts.desc.help")]] },
                ].map((group, i, arr) => (
                  <div key={group.title} className={`flex-1 ${i < arr.length - 1 ? "border-r border-white/10 pr-8" : ""}`}>
                    <div className="text-white/50 text-sm font-medium mb-2.5">{group.title}</div>
                    {group.items.map(([key, desc]) => (
                      <div key={key} className="flex items-center justify-between py-1.5">
                        <kbd className="bg-white/10 px-2 py-0.5 rounded text-sm font-mono text-white/80">{key}</kbd>
                        <span>{desc}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          }
          trigger="click"
          open={shortcutsOpen}
          onOpenChange={setShortcutsOpen}
          placement="top"
          styles={{ container: { padding: 16, background: "var(--canvas-bg)", marginBottom: 28 } }}
        >
          <Tooltip title={t("shortcuts")}>
            <button className="center-add-btn ant-btn-text ant-btn ant-btn-sm flex items-center justify-center rounded-md border-none cursor-pointer"
              style={{ background: "transparent", color: "var(--canvas-text)", fontSize: 18 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" /><line x1="6" y1="8" x2="6" y2="8" /><line x1="9" y1="8" x2="9" y2="8" /><line x1="12" y1="8" x2="12" y2="8" /><line x1="15" y1="8" x2="15" y2="8" /><line x1="18" y1="8" x2="18" y2="8" />
                <line x1="6" y1="12" x2="8" y2="12" /><line x1="18" y1="12" x2="18" y2="16" /><line x1="6" y1="16" x2="16" y2="16" />
              </svg>
            </button>
          </Tooltip>
        </Popover>
      </div>

      {ctxMenu && (
        <div className="fixed z-50" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={() => setCtxMenu(null)}>
          <div className="flex flex-col p-2 gap-0.5 rounded-lg shadow-lg" style={{ background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)" }}>
            <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
            <MenuItem onClick={() => { addNode("text"); setCtxMenu(null); }}><FontSizeOutlined /> {t("text.node")}</MenuItem>
            <MenuItem onClick={() => { addNode("image"); setCtxMenu(null); }}><PictureOutlined /> {t("image.node")}</MenuItem>
            <MenuItem onClick={() => { addNode("video"); setCtxMenu(null); }}><VideoCameraOutlined /> {t("video.node")}</MenuItem>
            <MenuDivider />
            <MenuItem onClick={() => { addNode("group"); setCtxMenu(null); }}><GroupOutlined /> {t("group.node")}</MenuItem>
          </div>
        </div>
      )}
      {ctxMenu && <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} />}
    </>
  );
}

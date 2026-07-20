"use client";

import { useState, useCallback, useEffect } from "react";
import { Popover, Tooltip, Button } from "antd";
import {
  PlusOutlined,
  FontSizeOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  GroupOutlined,
} from "@ant-design/icons";
import { useAddNode } from "@/hooks/use-add-node";
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

  const { addNode: addNodeAtCenter } = useAddNode();
  const addNode = useCallback((type: "text" | "image" | "video" | "group" | "director") => {
    addNodeAtCenter(type); setOpen(false);
  }, [addNodeAtCenter]);

  const menuContent = (
    <div className="menu-popover flex flex-col gap-0.5" style={{ minWidth: 160 }}>
      <MenuItem onClick={() => addNode("text")}><FontSizeOutlined /> {t("text.node")}</MenuItem>
      <MenuItem onClick={() => addNode("image")}><PictureOutlined /> {t("image.node")}</MenuItem>
      <MenuItem onClick={() => addNode("video")}><VideoCameraOutlined /> {t("video.node")}</MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => addNode("group")}><GroupOutlined /> {t("group.node")}</MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => addNode("director")}><VideoCameraOutlined /> {t("director.node")}</MenuItem>
    </div>
  );

  return (
    <>
      <div className="canvas-toolbar absolute left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-2xl z-10"
        style={{ bottom: 24, padding: "8px 12px" }}>
        <Popover content={menuContent} trigger="click" open={open} onOpenChange={setOpen} placement="top"
          styles={{ container: { padding: 0, background: "transparent" } }}>
          <Tooltip title={t("add.node")} open={open ? false : undefined}>
            <Button type="text" className="canvas-toolbar-btn" icon={<PlusOutlined style={{ fontSize: 20 }} />} />
          </Tooltip>
        </Popover>
        <span className="canvas-toolbar-sep" />
        <Popover content={
            <div className="flex gap-8 text-sm p-4" style={{ color: "var(--dir-dim)", minWidth: 900, background: "var(--menu-bg)", borderRadius: 12, border: "1px solid var(--menu-border)" }}>
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
          } trigger="click" open={shortcutsOpen} onOpenChange={setShortcutsOpen} placement="top"
          styles={{ container: { padding: 0, background: "transparent" } }}>
          <Tooltip title={t("shortcuts")} open={shortcutsOpen ? false : undefined}>
            <Button type="text" className="canvas-toolbar-btn" icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="4" width="20" height="16" rx="2" /><line x1="6" y1="8" x2="6" y2="8" /><line x1="9" y1="8" x2="9" y2="8" /><line x1="12" y1="8" x2="12" y2="8" /><line x1="15" y1="8" x2="15" y2="8" /><line x1="18" y1="8" x2="18" y2="8" /><line x1="6" y1="12" x2="8" y2="12" /><line x1="18" y1="12" x2="18" y2="16" /><line x1="6" y1="16" x2="16" y2="16" /></svg>} />
          </Tooltip>
        </Popover>
      </div>

      {ctxMenu && (
        <div className="fixed z-50" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={() => setCtxMenu(null)}>
          <div className="flex flex-col p-2 gap-0.5 rounded-lg shadow-lg" style={{ background: "var(--menu-bg)", border: "1px solid var(--menu-border)" }}>
            <MenuItem onClick={() => { addNode("text"); setCtxMenu(null); }}><FontSizeOutlined /> {t("text.node")}</MenuItem>
            <MenuItem onClick={() => { addNode("image"); setCtxMenu(null); }}><PictureOutlined /> {t("image.node")}</MenuItem>
            <MenuItem onClick={() => { addNode("video"); setCtxMenu(null); }}><VideoCameraOutlined /> {t("video.node")}</MenuItem>
            <MenuDivider />
            <MenuItem onClick={() => { addNode("group"); setCtxMenu(null); }}><GroupOutlined /> {t("group.node")}</MenuItem>
            <MenuDivider />
            <MenuItem onClick={() => { addNode("director"); setCtxMenu(null); }}><VideoCameraOutlined /> {t("director.node")}</MenuItem>
          </div>
        </div>
      )}
      {ctxMenu && <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} />}
    </>
  );
}

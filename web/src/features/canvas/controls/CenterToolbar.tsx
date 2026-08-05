/**
 * 画布底部中央工具条。
 * 提供「新增节点」下拉入口与快捷键说明弹窗，并监听画布右键事件在指针处
 * 复用同一套新增菜单。
 */
"use client";

import {
  GroupOutlined,
  PictureOutlined,
  PlusOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { Button,Popover, Tooltip } from "antd";
import { useCallback, useEffect,useState } from "react";

import { ShortcutIcon } from "@/components/ui/icons/canvas/ShortcutIcon";
import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { MenuDivider,MenuItem } from "@/components/ui/MenuPopover";
import { useAddNode } from "@/hooks/use-add-node";
import { useI18nStore } from "@/stores/i18n-store";

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
      <MenuItem onClick={() => addNode("text")}><TextIcon /> {t("text.node")}</MenuItem>
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
            <div className="flex gap-10 p-6" style={{ color: "var(--dir-dim)", background: "var(--menu-bg)", borderRadius: 12, border: "1px solid var(--menu-border)" }}>
              {[
                { title: t("shortcuts.zoom"), items: [["Ctrl+=", t("shortcuts.desc.zoomin")], ["Ctrl+-", t("shortcuts.desc.zoomout")], ["Ctrl+0", t("shortcuts.desc.reset")], [t("shortcuts.key.scroll"), t("shortcuts.desc.scroll")]] },
                { title: t("shortcuts.pan"), items: [[t("shortcuts.key.drag"), t("shortcuts.desc.pan")], [t("shortcuts.key.spaceDrag"), t("shortcuts.desc.temppan")]] },
                { title: t("shortcuts.edit"), items: [["Ctrl+C", t("shortcuts.desc.copy")], ["Ctrl+V", t("shortcuts.desc.paste")], ["Ctrl+Z", t("shortcuts.desc.undo")], ["Ctrl+Shift+Z", t("shortcuts.desc.redo")], ["Delete", t("shortcuts.desc.delete")]] },
                { title: t("shortcuts.group"), items: [["Ctrl+G", t("shortcuts.desc.group")], ["Ctrl+Shift+G", t("shortcuts.desc.ungroup")]] },
                { title: t("shortcuts.other"), items: [["Ctrl+A", t("shortcuts.desc.selectall")], ["Ctrl+M", t("shortcuts.desc.minimap")], [t("shortcuts.key.shiftClick"), t("shortcuts.desc.multiselect")], ["Escape", t("shortcuts.desc.esc")], ["?", t("shortcuts.desc.help")]] },
              ].map((group, i, arr) => (
                <div key={group.title} className={`${i < arr.length - 1 ? "border-r border-white/10 pr-10" : ""}`} style={{ width: 200, flexShrink: 0 }}>
                  <div className="text-white/50 text-sm font-medium mb-3">{group.title}</div>
                  {group.items.map(([key, desc]) => (
                    <div key={key} className="flex items-center justify-between gap-3 py-2">
                      <kbd className="bg-white/10 px-2.5 py-1 rounded text-sm font-mono text-white/80 whitespace-nowrap">{key}</kbd>
                      <span className="text-sm text-right">{desc}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          } trigger="click" open={shortcutsOpen} onOpenChange={setShortcutsOpen} placement="top"
          styles={{ container: { padding: 0, background: "transparent" } }}>
          <Tooltip title={t("shortcuts")} open={shortcutsOpen ? false : undefined}>
            <Button type="text" className="canvas-toolbar-btn" icon={<ShortcutIcon style={{ width: 18, height: 18 }} />} />
          </Tooltip>
        </Popover>
      </div>

      {ctxMenu && (
        <div className="fixed z-50" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={() => setCtxMenu(null)}>
          <div className="flex flex-col p-2 gap-0.5 rounded-lg shadow-lg" style={{ background: "var(--menu-bg)", border: "1px solid var(--menu-border)" }}>
            <MenuItem onClick={() => { addNode("text"); setCtxMenu(null); }}><TextIcon /> {t("text.node")}</MenuItem>
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

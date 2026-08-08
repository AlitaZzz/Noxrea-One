/**
 * 画布空白处右键菜单。
 * 从 context-menu store 读取弹出位置与显隐，渲染「新增各类节点 / 重置视图」菜单项，
 * 具体动作由父级通过 props 注入，自身不含业务逻辑。
 */
"use client";

import { ExpandOutlined, PartitionOutlined, PictureOutlined, VideoCameraOutlined } from "@ant-design/icons";

import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { MenuDivider,MenuItem } from "@/components/ui/MenuPopover";
import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";
import { useTranslation } from "react-i18next";

interface Props {
  onAddText: () => void;
  onAddImage: () => void;
  onAddVideo: () => void;
  onAddAudio: () => void;
  onAddDirector: () => void;
  onResetView: () => void;
}

export default function CanvasContextMenu(props: Props) {
  const { t } = useTranslation();
  const { x, y, visible, hide } = useContextMenuStore();

  if (!visible) return null;

  return (
    <>
      <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
      <div className="fixed inset-0 z-50" onClick={hide} onContextMenu={(e) => { e.preventDefault(); hide(); }} />
      <div
        className="fixed z-50 flex flex-col p-2 gap-0.5 rounded-lg shadow-xl"
        style={{
          left: Math.min(x, window.innerWidth - 180),
          top: Math.min(y, window.innerHeight - 240),
          background: "var(--canvas-bg)",
          border: "1px solid var(--canvas-border)",
          minWidth: 175,
          userSelect: "none",
        }}
      >
        <div style={{ padding: "2px 4px 0", fontSize: 11, color: "var(--canvas-text-muted)" }}>{t("node.add")}</div>
        <MenuItem onClick={() => { props.onAddText(); hide(); }}><TextIcon /> {t("node.text")}</MenuItem>
        <MenuItem onClick={() => { props.onAddImage(); hide(); }}><PictureOutlined /> {t("node.image")}</MenuItem>
        <MenuItem onClick={() => { props.onAddVideo(); hide(); }}><VideoCameraOutlined /> {t("node.video")}</MenuItem>
        <MenuItem onClick={() => { props.onAddAudio(); hide(); }}><WaveIcon /> {t("node.audio")}</MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => { props.onAddDirector(); hide(); }}><PartitionOutlined /> {t("node.director")}</MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => { props.onResetView(); hide(); }}><ExpandOutlined /> {t("canvas.fit")}</MenuItem>
      </div>
    </>
  );
}

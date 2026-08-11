/**
 * 拖拽连线到空白处时弹出的「创建连接节点」菜单。
 * 根据源节点类型，合法目标节点类型可点击，不合法的显示为禁用。
 */
"use client";

import { PictureOutlined, VideoCameraOutlined } from "@ant-design/icons";

import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { MenuItem } from "@/components/ui/MenuPopover";
import { canConnect, canConnectToInput, NODE_TYPE } from "@/lib/constants";
import { useTranslation } from "react-i18next";

export interface PendingConnectionCreate {
  /** 发起拖拽的节点（即用户从它的 Handle 拖出的那个节点） */
  sourceNodeId: string;
  sourceNodeType: string;
  /** 连接方向：从 source 节点右侧 Handle 拖出 = "output"（新节点为下游）；
   *            从 source 节点左侧 Handle 拉入 = "input"（新节点为上游） */
  direction: "input" | "output";
  /** 画布坐标（用于在新节点位置创建） */
  canvasPosition: { x: number; y: number };
  /** 屏幕坐标（用于菜单定位） */
  screenPosition: { x: number; y: number };
}

interface Props {
  pending: PendingConnectionCreate;
  onSelect: (nodeType: string) => void;
  onClose: () => void;
}

export default function ConnectionCreateMenu({ pending, onSelect, onClose }: Props) {
  const { t } = useTranslation();

  const nodeOptions = [
    { type: NODE_TYPE.TEXT, label: t("node.text"), icon: <TextIcon /> },
    { type: NODE_TYPE.IMAGE, label: t("node.image"), icon: <PictureOutlined /> },
    { type: NODE_TYPE.VIDEO, label: t("node.video"), icon: <VideoCameraOutlined /> },
    { type: NODE_TYPE.AUDIO, label: t("node.audio"), icon: <WaveIcon /> },
  ];

  return (
    <>
      <style>{`.menu-popover-item:not(.menu-item-disabled):hover { background: var(--canvas-bg-hover) !important; }`}</style>
      <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="fixed z-50 flex flex-col p-2 gap-0.5 rounded-lg shadow-xl"
        style={{
          left: Math.min(pending.screenPosition.x, window.innerWidth - 180),
          top: Math.min(pending.screenPosition.y, window.innerHeight - 240),
          background: "var(--canvas-bg)",
          border: "1px solid var(--canvas-border)",
          minWidth: 175,
          userSelect: "none",
        }}
      >
        <div style={{ padding: "2px 4px 0", fontSize: 11, color: "var(--canvas-text-muted)" }}>
          {pending.direction === "input" ? t("node.connectCreateInput") : t("node.connectCreateOutput")}
        </div>
        {nodeOptions.map((opt) => {
          const disabled =
            pending.direction === "output"
              ? !canConnect(pending.sourceNodeType, opt.type)
              : !canConnectToInput(pending.sourceNodeType, opt.type);
          return (
            <MenuItem
              key={opt.type}
              dimmed={disabled}
              onClick={() => {
                if (!disabled) {
                  onSelect(opt.type);
                  onClose();
                }
              }}
            >
              {opt.icon} {opt.label}
            </MenuItem>
          );
        })}
      </div>
    </>
  );
}

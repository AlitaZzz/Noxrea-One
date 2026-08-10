/**
 * 节点悬浮工具条。
 * 按节点类型渲染对应操作（下载、裁剪、宫格切分、打光、多视角、翻转旋转、
 * 收藏到资产、删除等），操作本身不落地，统一通过自定义事件派发给节点组件执行。
 */
"use client";

import {
  CameraOutlined,
  DeleteOutlined,
  DownloadOutlined,
  HighlightOutlined,
  InfoCircleOutlined,
  RotateRightOutlined,
  ScissorOutlined,
  StarFilled,
  StarOutlined,
} from "@ant-design/icons";
import { Button, Popover,Tooltip } from "antd";
import { Eraser, FlipHorizontal, FlipVertical } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { GridSplitIcon } from "@/components/ui/icons/canvas/GridSplitIcon";
import { LightingIcon } from "@/components/ui/icons/canvas/LightingIcon";
import { MultiAngleIcon } from "@/components/ui/icons/canvas/MultiAngleIcon";
import { UngroupIcon } from "@/components/ui/icons/canvas/UngroupIcon";
import { GroupGridIcon } from "@/components/ui/icons/canvas/GroupGridIcon";
import { MenuDivider, MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import { EventNames } from "@/lib/constants";
import { useAssetsStore } from "@/features/assets/store";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useTranslation } from "react-i18next";

const NODE_ACTIONS = {
  IMAGE: "image-node" as const,
  VIDEO: "video-node" as const,
  AUDIO: "audio-node" as const,
  TEXT: "text-node" as const,
  GROUP: "group-node" as const,
};

interface NodeToolbarProps {
  nodeId: string;
  nodeType?: string;
  onShowInspector: (nodeId: string) => void;
}

function dispatchNodeAction(nodeId: string, action: string, extra?: Record<string, unknown>) {
  window.dispatchEvent(
    new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId, action, ...extra } })
  );
}

/** 宫格切分选择器 — 鼠标划过高亮行列数，点击确认 */
function GridPicker({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState({ rows: 0, cols: 0 });
  const MAX = 5;
  return (
    <div className="flex flex-col gap-0.5">
      <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
      {[2, 3, 4, 5].map((n) => (
        <MenuItem key={n} onClick={() => dispatchNodeAction(nodeId, "grid-split", { rows: n, cols: n })}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <GridSplitIcon />
            {n === 2 ? "4" : n === 3 ? "9" : n === 4 ? "16" : "25"}×{n}
          </span>
        </MenuItem>
      ))}
      <MenuDivider />
      <div style={{ padding: "4px 4px 0" }}>
        <div className="text-xs mb-1.5" style={{ color: "var(--canvas-text-muted)" }}>{t("node.gridCustom")}</div>
        <div className="text-xs mb-1 text-center" style={{ color: "var(--canvas-text)" }}>
          {hover.rows > 0 && hover.cols > 0 ? `${hover.rows}×${hover.cols}` : t("node.gridSelect")}
        </div>
        <div className="flex justify-center">
          <div className="inline-grid gap-[1px]" style={{
            gridTemplateColumns: `repeat(${MAX}, 14px)`,
            background: "var(--canvas-border)",
            border: "1px solid var(--canvas-border)",
          }}>
            {Array.from({ length: MAX * MAX }).map((_, i) => {
              const row = Math.floor(i / MAX) + 1;
              const col = (i % MAX) + 1;
              const active = row <= hover.rows && col <= hover.cols;
              return (
                <div key={i}
                  onMouseEnter={() => setHover({ rows: row, cols: col })}
                  onClick={() => dispatchNodeAction(nodeId, "grid-split", { rows: row, cols: col })}
                  style={{
                    width: 14, height: 14,
                    background: active ? "#1D9E75" : "var(--canvas-bg)",
                    cursor: "pointer",
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function NodeToolbar({ nodeId, nodeType, onShowInspector }: NodeToolbarProps) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const knownAssetUrls = useAssetsStore((s) => s.knownAssetUrls);
  const assetSrc = (nodes.find(n => n.id === nodeId)?.data as { src?: string })?.src;
  const textContent = (nodes.find(n => n.id === nodeId)?.data as { content?: string })?.content;
  const isInAssets = useMemo(() => !!assetSrc && knownAssetUrls.has(assetSrc), [assetSrc, knownAssetUrls]);
  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      window.dispatchEvent(
        new CustomEvent(EventNames.CANVAS_DELETE_NODES, { detail: { nodeIds: [nodeId] } })
      );
    },
    [nodeId]
  );

  const handleInfo = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onShowInspector(nodeId);
    },
    [nodeId, onShowInspector]
  );

  return (
    <div
      className="canvas-toolbar absolute -top-[62px] left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-xl z-20"
      style={{ height: 50, padding: "6px 10px", whiteSpace: "nowrap" }}
    >
      <Tooltip title={t("common.info")}>
        <Button
          type="text"
          size="middle"
          style={{ padding: 8 }}
          icon={<InfoCircleOutlined />}
          onClick={handleInfo}
        />
      </Tooltip>
      <Tooltip title={`${t("common.delete")} (Delete)`}>
        <Button
          type="text"
          size="middle"
          style={{ padding: 8 }}
          className="text-white/40 hover:text-white"
          icon={<DeleteOutlined />}
          onClick={handleDelete}
        />
      </Tooltip>

      {/* Image node actions */}
      {nodeType === NODE_ACTIONS.IMAGE && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          {/* Edit */}
          <Popover trigger="click" placement="bottom"
            content={<div className="flex flex-col p-2 gap-0.5" style={{ margin: -12, background: "var(--canvas-bg)", borderRadius: 8, minWidth: 190 }}>
              <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
              <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "rot90" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><RotateRightOutlined style={{ fontSize: 14 }} /> {t("node.rotate90")}</span></MenuItem>
              <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "flipH" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><FlipHorizontal size={14} /> {t("node.flipH")}</span></MenuItem>
              <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "flipV" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><FlipVertical size={14} /> {t("node.flipV")}</span></MenuItem>
            </div>}>
            <Tooltip title={t("node.transform")}>
              <Button type="text" size="middle" style={{ padding: 8 }} icon={<RotateRightOutlined />} disabled={!assetSrc} />
            </Tooltip>
          </Popover>
          <Tooltip title={t("node.crop")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<ScissorOutlined />} disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "crop-interactive")} />
          </Tooltip>
          <Tooltip title={t("annotation.title")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<HighlightOutlined />} disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "annotate")} />
          </Tooltip>
          <Popover trigger="click" placement="bottom"
            content={<div className="flex flex-col p-2 gap-0.5" style={{ margin: -12, background: "var(--canvas-bg)", borderRadius: 8, minWidth: 190 }}>
              <GridPicker nodeId={nodeId} />
            </div>}>
            <Tooltip title={t("node.gridSplit")}>
              <Button type="text" size="middle" style={{ padding: 8 }} disabled={!assetSrc}>
                <GridSplitIcon />
              </Button>
            </Tooltip>
          </Popover>
          {/* AI */}
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("angle.editor")}>
            <Button type="text" size="middle" style={{ padding: 8 }}
              icon={<MultiAngleIcon />}
              onClick={() => dispatchNodeAction(nodeId, "angle-editor")} disabled={!assetSrc} />
          </Tooltip>
          <Tooltip title={t("lighting.title")}>
            <Button type="text" size="middle" style={{ padding: 8 }}
              icon={<LightingIcon />}
              onClick={() => dispatchNodeAction(nodeId, "lighting")} disabled={!assetSrc} />
          </Tooltip>
          {/* Export */}
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={isInAssets ? t("node.alreadySaved") : t("node.saveToAssets")}>
            <Button type="text" size="middle" style={{ padding: 8 }} disabled={!assetSrc}
              icon={isInAssets ? <StarFilled style={{ color: "#faad14" }} /> : <StarOutlined />}
              onClick={() => { if (!isInAssets) dispatchNodeAction(nodeId, "save-asset"); }} />
          </Tooltip>
          <Tooltip title={t("common.download")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DownloadOutlined />} disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "download")} />
          </Tooltip>
          {/* Reset */}
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("common.clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={15} />} disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}

      {/* Video node actions */}
      {nodeType === NODE_ACTIONS.VIDEO && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("common.download")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DownloadOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "download")} />
          </Tooltip>
          <Tooltip title={t("common.clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={15} />}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}

      {/* Audio node actions — 基础工具栏：下载 / 清除（上传在节点内） */}
      {nodeType === NODE_ACTIONS.AUDIO && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("common.download")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DownloadOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "download")} />
          </Tooltip>
          <Tooltip title={t("common.clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={15} />}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}

      {/* Text node actions */}
      {nodeType === NODE_ACTIONS.TEXT && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("common.clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={15} />} disabled={!textContent}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}

      {/* Group node actions */}
      {nodeType === NODE_ACTIONS.GROUP && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("common.ungroup")}>
            <Button
              type="text"
              size="middle"
              style={{ padding: 8 }}
              icon={<UngroupIcon />}
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent(EventNames.CANVAS_UNGROUP_NODES));
              }}
            />
          </Tooltip>
          <Tooltip title={t("common.layout")}>
            <Button
              type="text"
              size="middle"
              style={{ padding: 8 }}
              icon={<GroupGridIcon />}
              onClick={(e) => {
                e.stopPropagation();
              }}
            />
          </Tooltip>
        </>
      )}
    </div>
  );
}

export default memo(NodeToolbar);

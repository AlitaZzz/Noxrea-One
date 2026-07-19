"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { Button, Tooltip, Popover } from "antd";
import { useCanvasStore } from "@/stores/canvas-store";
import { useAssetsStore } from "@/stores/assets-store";
import {
  DeleteOutlined,
  InfoCircleOutlined,
  DownloadOutlined,
  StarOutlined,
  StarFilled,
  ScissorOutlined,
  RotateRightOutlined,
  CameraOutlined,
  ExperimentOutlined,
} from "@ant-design/icons";
import { Eraser, FlipHorizontal, FlipVertical } from "lucide-react";
import { useI18nStore } from "@/stores/i18n-store";
import { EventNames } from "@/lib/eventNames";
import { MenuItem, MenuDivider, MenuPopover } from "@/components/common/MenuPopover";

const NODE_ACTIONS = {
  IMAGE: "image-node" as const,
  VIDEO: "video-node" as const,
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
  const t = useI18nStore((s) => s.t);
  const [hover, setHover] = useState({ rows: 0, cols: 0 });
  const MAX = 5;
  return (
    <div className="flex flex-col gap-0.5">
      <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
      {[2, 3, 4, 5].map((n) => (
        <MenuItem key={n} onClick={() => dispatchNodeAction(nodeId, "grid-split", { rows: n, cols: n })}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="12" y1="3" x2="12" y2="21" />
            </svg>
            {n === 2 ? "4" : n === 3 ? "9" : n === 4 ? "16" : "25"}×{n}
          </span>
        </MenuItem>
      ))}
      <MenuDivider />
      <div style={{ padding: "4px 4px 0" }}>
        <div className="text-xs mb-1.5" style={{ color: "var(--canvas-text-muted)" }}>{t("grid.custom")}</div>
        <div className="text-xs mb-1 text-center" style={{ color: "var(--canvas-text)" }}>
          {hover.rows > 0 && hover.cols > 0 ? `${hover.rows}×${hover.cols}` : t("grid.select")}
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
  const t = useI18nStore((s) => s.t);
  const nodes = useCanvasStore((s) => s.nodes);
  const items = useAssetsStore((s) => s.items);
  const assetSrc = (nodes.find(n => n.id === nodeId)?.data as any)?.src;
  const isInAssets = useMemo(() => !!assetSrc && items.some(i => i.metadata?.sourceUrl === assetSrc), [assetSrc, items]);
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
      className="absolute -top-[62px] left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-white dark:bg-zinc-800 rounded-md shadow-lg border border-zinc-200 dark:border-zinc-700 h-[50px] px-2 py-2 z-20"
      style={{ whiteSpace: "nowrap" }}
    >
      <Tooltip title={`${t("info")} & JSON`}>
        <Button
          type="text"
          size="middle"
          style={{ padding: 8 }}
          icon={<InfoCircleOutlined />}
          onClick={handleInfo}
        />
      </Tooltip>
      <Tooltip title={`${t("delete")} (Delete)`}>
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
          <Tooltip title={t("download")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DownloadOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "download")} />
          </Tooltip>
          <Tooltip title={isInAssets ? t("asset.alreadySaved") : t("save.assets")}>
            <Button type="text" size="middle" style={{ padding: 8 }}
              icon={isInAssets ? <StarFilled style={{ color: "#faad14" }} /> : <StarOutlined />}
              onClick={() => { if (!isInAssets) dispatchNodeAction(nodeId, "save-asset"); }} />
          </Tooltip>
          <Popover trigger="click" placement="bottom"
            content={<div className="flex flex-col p-2 gap-0.5" style={{ margin: -12, background: "var(--canvas-bg)", borderRadius: 8, minWidth: 190 }}>
              <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
              <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "rot90" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><RotateRightOutlined style={{ fontSize: 14 }} /> {t("rotate90")}</span></MenuItem>
              <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "flipH" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><FlipHorizontal size={14} /> {t("flipH")}</span></MenuItem>
              <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "flipV" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><FlipVertical size={14} /> {t("flipV")}</span></MenuItem>
            </div>}>
            <Tooltip title={t("transform")}>
              <Button type="text" size="middle" style={{ padding: 8 }} icon={<RotateRightOutlined />} />
            </Tooltip>
          </Popover>
          <Tooltip title={t("crop")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<ScissorOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "crop-interactive")} />
          </Tooltip>
          <Popover trigger="click" placement="bottom"
            content={<div className="flex flex-col p-2 gap-0.5" style={{ margin: -12, background: "var(--canvas-bg)", borderRadius: 8, minWidth: 190 }}>
              <GridPicker nodeId={nodeId} />
            </div>}>
            <Tooltip title={t("grid.split")}>
              <Button type="text" size="middle" style={{ padding: 8 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "middle", marginRight: 6 }}>
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="12" y1="3" x2="12" y2="21" />
                </svg>
              </Button>
            </Tooltip>
          </Popover>
          <Tooltip title={t("bg_removal")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<ExperimentOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "bg-removal")} />
          </Tooltip>
          <Tooltip title={t("clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={15} />}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}

      {/* Video node actions */}
      {nodeType === NODE_ACTIONS.VIDEO && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("download")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DownloadOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "download")} />
          </Tooltip>
          <Tooltip title={t("clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={15} />}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}
    </div>
  );
}

export default memo(NodeToolbar);

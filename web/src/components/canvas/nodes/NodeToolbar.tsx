"use client";

import {
  CameraOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ExperimentOutlined,
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

import { MenuDivider, MenuItem, MenuPopover } from "@/components/common/MenuPopover";
import { EventNames } from "@/lib/event-names";
import { useAssetsStore } from "@/stores/assets-store";
import { useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";

const NODE_ACTIONS = {
  IMAGE: "image-node" as const,
  VIDEO: "video-node" as const,
  AUDIO: "audio-node" as const,
  TEXT: "text-node" as const,
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
      <Tooltip title={t("info")}>
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
          {/* Edit */}
          <Popover trigger="click" placement="bottom"
            content={<div className="flex flex-col p-2 gap-0.5" style={{ margin: -12, background: "var(--canvas-bg)", borderRadius: 8, minWidth: 190 }}>
              <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
              <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "rot90" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><RotateRightOutlined style={{ fontSize: 14 }} /> {t("rotate90")}</span></MenuItem>
              <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "flipH" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><FlipHorizontal size={14} /> {t("flipH")}</span></MenuItem>
              <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "flipV" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><FlipVertical size={14} /> {t("flipV")}</span></MenuItem>
            </div>}>
            <Tooltip title={t("transform")}>
              <Button type="text" size="middle" style={{ padding: 8 }} icon={<RotateRightOutlined />} disabled={!assetSrc} />
            </Tooltip>
          </Popover>
          <Tooltip title={t("crop")}>
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
            <Tooltip title={t("grid.split")}>
              <Button type="text" size="middle" style={{ padding: 8 }} disabled={!assetSrc}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "middle", marginRight: 6 }}>
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="12" y1="3" x2="12" y2="21" />
                </svg>
              </Button>
            </Tooltip>
          </Popover>
          {/* AI */}
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("angle.editor")}>
            <Button type="text" size="middle" style={{ padding: 8 }}
              icon={<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="pointer-events-none h-4 w-4" viewBox="0 0 21.6 21.8"><path d="M10.9 0c1.35 0 2.5.77 3.36 1.87.79.99 1.41 2.31 1.84 3.82q.8.23 1.51.52c1.82.75 3.33 1.88 3.92 3.35a.9.9 0 0 1-1.66.68c-.33-.81-1.3-1.69-2.95-2.36a18 18 0 0 0-9.75-.7 18 18 0 0 0-.37 3.72 18 18 0 0 0 .38 3.72 18 18 0 0 0 8.47-.25l-1.95-.95a.9.9 0 1 1 .79-1.62l3.81 1.86a.9.9 0 0 1 .42 1.2l-1.86 3.82a.9.9 0 1 1-1.62-.8l.87-1.77a20 20 0 0 1-8.38.45q.2.55.44 1C9.03 19.29 10.04 20 10.9 20q.33 0 .66-.13a.9.9 0 0 1 .68 1.66q-.64.27-1.34.27c-1.9 0-3.39-1.52-4.34-3.43a13 13 0 0 1-.87-2.26 13 13 0 0 1-2.26-.87C1.53 14.3 0 12.81 0 10.9s1.52-3.39 3.43-4.34a13 13 0 0 1 2.26-.87q.36-1.24.87-2.26C7.51 1.53 9 0 10.9 0M5.25 7.73q-.55.2-1.02.44c-1.71.86-2.43 1.87-2.43 2.73s.72 1.87 2.43 2.73q.47.23 1.02.44a20 20 0 0 1 0-6.34M10.9 1.8c-.86 0-1.87.72-2.73 2.43q-.24.47-.44 1.02a20 20 0 0 1 6.33 0 8 8 0 0 0-1.2-2.26c-.68-.85-1.36-1.19-1.96-1.19" fill="currentColor" /></svg>}
              onClick={() => dispatchNodeAction(nodeId, "angle-editor")} disabled={!assetSrc} />
          </Tooltip>
          <Tooltip title={t("lighting.title")}>
            <Button type="text" size="middle" style={{ padding: 8 }}
              icon={<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="pointer-events-none h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>}
              onClick={() => dispatchNodeAction(nodeId, "lighting")} disabled={!assetSrc} />
          </Tooltip>
          <Tooltip title={t("bg_removal")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<ExperimentOutlined />} disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "bg-removal")} />
          </Tooltip>
          {/* Export */}
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={isInAssets ? t("asset.alreadySaved") : t("save.assets")}>
            <Button type="text" size="middle" style={{ padding: 8 }} disabled={!assetSrc}
              icon={isInAssets ? <StarFilled style={{ color: "#faad14" }} /> : <StarOutlined />}
              onClick={() => { if (!isInAssets) dispatchNodeAction(nodeId, "save-asset"); }} />
          </Tooltip>
          <Tooltip title={t("download")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DownloadOutlined />} disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "download")} />
          </Tooltip>
          {/* Reset */}
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={15} />} disabled={!assetSrc}
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

      {/* Audio node actions — 基础工具栏：下载 / 清除（上传在节点内） */}
      {nodeType === NODE_ACTIONS.AUDIO && (
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

      {/* Text node actions */}
      {nodeType === NODE_ACTIONS.TEXT && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={15} />} disabled={!textContent}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}
    </div>
  );
}

export default memo(NodeToolbar);

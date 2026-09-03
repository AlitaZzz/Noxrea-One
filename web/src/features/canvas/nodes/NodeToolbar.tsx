/**
 * 节点悬浮工具条。
 * 按节点类型渲染对应操作（下载、裁剪、宫格切分、打光、多视角、翻转旋转、
 * 收藏到资产、删除等），操作本身不落地，统一通过自定义事件派发给节点组件执行。
 */
"use client";

import {
  BgColorsOutlined,
  CameraOutlined,
  CheckOutlined,
  CopyOutlined,
  DownloadOutlined,
  ExpandOutlined,
  FileTextOutlined,
  HighlightOutlined,
  InfoCircleOutlined,
  RotateRightOutlined,
  ScissorOutlined,
  StarFilled,
  StarOutlined,
} from "@ant-design/icons";
import { Button, Popover,Tooltip } from "antd";
import { Eraser, FlipHorizontal, FlipVertical, Wand2 } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AlignHorizontalIcon } from "@/components/ui/icons/canvas/AlignHorizontalIcon";
import { AlignVerticalIcon } from "@/components/ui/icons/canvas/AlignVerticalIcon";
import { Back5sIcon } from "@/components/ui/icons/canvas/Back5sIcon";
import { CharacterFaceThreeViewIcon } from "@/components/ui/icons/canvas/CharacterFaceThreeViewIcon";
import { CharacterThreeViewIcon } from "@/components/ui/icons/canvas/CharacterThreeViewIcon";
import { Forward3sIcon } from "@/components/ui/icons/canvas/Forward3sIcon";
import { GridSplitIcon } from "@/components/ui/icons/canvas/GridSplitIcon";
import { GroupGridIcon } from "@/components/ui/icons/canvas/GroupGridIcon";
import { LightingIcon } from "@/components/ui/icons/canvas/LightingIcon";
import { MultiAngleIcon } from "@/components/ui/icons/canvas/MultiAngleIcon";
import { NineGridIcon } from "@/components/ui/icons/canvas/NineGridIcon";
import { PanoramaIcon } from "@/components/ui/icons/canvas/PanoramaIcon";
import { Storyboard4Icon } from "@/components/ui/icons/canvas/Storyboard4Icon";
import { Storyboard25Icon } from "@/components/ui/icons/canvas/Storyboard25Icon";
import { UngroupIcon } from "@/components/ui/icons/canvas/UngroupIcon";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { MenuDivider, MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import { useAssetsStore } from "@/features/assets/store";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { DEFAULT_GROUP_COLOR_KEY, EventNames, getGroupColor,GROUP_COLOR_KEYS, GROUP_COLORS } from "@/lib/constants";

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
      {[2, 3, 4, 5].map((n) => (
        <MenuItem key={n} onClick={() => dispatchNodeAction(nodeId, "grid-split", { rows: n, cols: n })}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <GridSplitIcon style={{ fontSize: 16 }} />
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

/** 分组节点配色选择器 — 9 色网格，点击即时生效 */
function GroupColorPicker({ nodeId, current }: { nodeId: string; current: string | undefined }) {
  const { t } = useTranslation();
  const handlePick = useCallback(
    (key: string) => {
      window.dispatchEvent(
        new CustomEvent(EventNames.NODE_UPDATE_DATA, {
          detail: { nodeId, data: { color: key }, immediate: true },
        })
      );
    },
    [nodeId]
  );
  return (
    <div className="menu-popover">
      <div className="text-xs mb-2 px-1" style={{ color: "var(--canvas-text-muted)" }}>{t("node.groupColor")}</div>
      <div className="grid grid-cols-5 gap-2">
        {GROUP_COLOR_KEYS.map((key) => {
          const preset = GROUP_COLORS[key];
          const isDefault = key === "default";
          const selected = (current ?? DEFAULT_GROUP_COLOR_KEY) === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => handlePick(key)}
              className="relative flex items-center justify-center rounded-full transition-transform hover:scale-110"
              style={{
                width: 26,
                height: 26,
                border: `2px solid ${preset.border}`,
                background: isDefault ? "transparent" : preset.fill,
                cursor: "pointer",
                boxShadow: selected ? `0 0 0 2px var(--canvas-bg), 0 0 0 3px ${preset.border}` : "none",
              }}
            >
              {isDefault && (
                <span
                  style={{
                    position: "absolute",
                    width: 20,
                    height: 2,
                    background: "var(--canvas-text-muted)",
                    transform: "rotate(45deg)",
                    borderRadius: 1,
                  }}
                />
              )}
              {selected && !isDefault && (
                <CheckOutlined style={{ fontSize: 12, color: preset.border }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NodeToolbar({ nodeId, nodeType, onShowInspector }: NodeToolbarProps) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const knownAssetUrls = useAssetsStore((s) => s.knownAssetUrls);
  const assetSrc = (nodes.find(n => n.id === nodeId)?.data as { src?: string })?.src;
  // 音轨探测结论：undefined = 尚未确定（按「可能有音轨」处理，真无音轨时由后端兜底）；
  // false = 确定无音轨，禁用分离入口
  const videoHasAudio = (nodes.find(n => n.id === nodeId)?.data as { hasAudio?: boolean })?.hasAudio;
  const textContent = (nodes.find(n => n.id === nodeId)?.data as { plainText?: string })?.plainText;
  const groupColor = (nodes.find(n => n.id === nodeId)?.data as { color?: string })?.color;
  const isInAssets = useMemo(() => !!assetSrc && knownAssetUrls.has(assetSrc), [assetSrc, knownAssetUrls]);
  const [creationOpen, setCreationOpen] = useState(false);
  const [transformOpen, setTransformOpen] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const handleInfo = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onShowInspector(nodeId);
    },
    [nodeId, onShowInspector]
  );

  return (
    <div
      className="canvas-toolbar flex items-center gap-1 rounded-xl z-20"
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

      {/* Image node actions */}
      {nodeType === NODE_ACTIONS.IMAGE && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          {/* 全景 */}
          <Tooltip title={t("node.panorama")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<PanoramaIcon />} disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "panorama")} />
          </Tooltip>
          {/* Edit */}
          <MenuPopover
            open={transformOpen}
            onOpenChange={setTransformOpen}
            placement="bottom"
            trigger={
              <Tooltip title={t("node.transform")}>
                <Button type="text" size="middle" style={{ padding: 8 }} icon={<RotateRightOutlined />} disabled={!assetSrc} />
              </Tooltip>
            }
            content={
              <>
                <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "rot90" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><RotateRightOutlined style={{ fontSize: 16 }} /> {t("node.rotate90")}</span></MenuItem>
                <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "flipH" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><FlipHorizontal size={16} /> {t("node.flipH")}</span></MenuItem>
                <MenuItem onClick={() => dispatchNodeAction(nodeId, "transform", { op: "flipV" })}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><FlipVertical size={16} /> {t("node.flipV")}</span></MenuItem>
              </>
            }
          />
          <Tooltip title={t("node.crop")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<ScissorOutlined />} disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "crop-interactive")} />
          </Tooltip>
          <Tooltip title={t("annotation.title")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<HighlightOutlined />} disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "annotate")} />
          </Tooltip>
          <MenuPopover
            open={gridOpen}
            onOpenChange={setGridOpen}
            placement="bottom"
            trigger={
              <Tooltip title={t("node.gridSplit")}>
                <Button type="text" size="middle" style={{ padding: 8 }} disabled={!assetSrc}>
                  <GridSplitIcon />
                </Button>
              </Tooltip>
            }
            content={<GridPicker nodeId={nodeId} />}
          />
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
          <MenuPopover
            open={creationOpen}
            onOpenChange={setCreationOpen}
            placement="bottomRight"
            trigger={
              <Tooltip title={t("node.creation")}>
                <Button type="text" size="middle" style={{ padding: 8 }} icon={<Wand2 size={16} />} disabled={!assetSrc} />
              </Tooltip>
            }
            content={
              <>
                <MenuItem onClick={() => { setCreationOpen(false); dispatchNodeAction(nodeId, "create-reverse"); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <FileTextOutlined style={{ fontSize: 16 }} />
                    {t("node.creationReverse")}
                  </span>
                </MenuItem>
                <MenuItem onClick={() => { setCreationOpen(false); dispatchNodeAction(nodeId, "create-character-face"); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <CharacterFaceThreeViewIcon style={{ fontSize: 16 }} />
                    {t("node.creationCharacterFace")}
                  </span>
                </MenuItem>
                <MenuItem onClick={() => { setCreationOpen(false); dispatchNodeAction(nodeId, "create-character-three-view"); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <CharacterThreeViewIcon style={{ fontSize: 16 }} />
                    {t("node.creationCharacterThreeView")}
                  </span>
                </MenuItem>
                <MenuItem onClick={() => { setCreationOpen(false); dispatchNodeAction(nodeId, "create-nine-grid-scene"); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <NineGridIcon style={{ fontSize: 16 }} />
                    {t("node.creationNineGrid")}
                  </span>
                </MenuItem>
                <MenuItem onClick={() => { setCreationOpen(false); dispatchNodeAction(nodeId, "create-25-grid-storyboard"); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Storyboard25Icon style={{ fontSize: 16 }} />
                    {t("node.creation25Grid")}
                  </span>
                </MenuItem>
                <MenuItem onClick={() => { setCreationOpen(false); dispatchNodeAction(nodeId, "create-4-grid-storyboard"); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Storyboard4Icon style={{ fontSize: 16 }} />
                    {t("node.creation4Grid")}
                  </span>
                </MenuItem>
                <MenuItem onClick={() => { setCreationOpen(false); dispatchNodeAction(nodeId, "create-forward-3s"); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Forward3sIcon style={{ fontSize: 16 }} />
                    {t("node.creationForward3s")}
                  </span>
                </MenuItem>
                <MenuItem onClick={() => { setCreationOpen(false); dispatchNodeAction(nodeId, "create-back-5s"); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Back5sIcon style={{ fontSize: 16 }} />
                    {t("node.creationBack5s")}
                  </span>
                </MenuItem>
              </>
            }
          />
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
          <Tooltip title={t("node.previewFullscreen")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<ExpandOutlined />} disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "preview-fullscreen")} />
          </Tooltip>
          {/* Reset */}
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("common.clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={16} />} disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}

      {/* Video node actions */}
      {nodeType === NODE_ACTIONS.VIDEO && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <MenuPopover
            open={captureOpen}
            onOpenChange={setCaptureOpen}
            placement="bottom"
            trigger={
              <Tooltip title={t("node.captureFrame")}>
                <Button type="text" size="middle" style={{ padding: 8 }} icon={<CameraOutlined />} disabled={!assetSrc} />
              </Tooltip>
            }
            content={
              <>
                <MenuItem onClick={() => { setCaptureOpen(false); dispatchNodeAction(nodeId, "capture-frame", { time: null }); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <CameraOutlined style={{ fontSize: 16 }} /> {t("capture.currentFrame")}
                  </span>
                </MenuItem>
                <MenuItem onClick={() => { setCaptureOpen(false); dispatchNodeAction(nodeId, "capture-frame", { time: 0 }); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <CameraOutlined style={{ fontSize: 16 }} /> {t("capture.firstFrame")}
                  </span>
                </MenuItem>
                <MenuItem onClick={() => { setCaptureOpen(false); dispatchNodeAction(nodeId, "capture-frame", { time: -1 }); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <CameraOutlined style={{ fontSize: 16 }} /> {t("capture.lastFrame")}
                  </span>
                </MenuItem>
              </>
            }
          />
          <Tooltip title={videoHasAudio === false ? t("node.detachAudioNoTrack") : t("node.detachAudio")}>
            <Button
              type="text"
              size="middle"
              style={{ padding: 8 }}
              icon={<WaveIcon />}
              disabled={!assetSrc || videoHasAudio === false}
              onClick={() => dispatchNodeAction(nodeId, "detach-audio")}
            />
          </Tooltip>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={isInAssets ? t("node.alreadySaved") : t("node.saveToAssets")}>
            <Button type="text" size="middle" style={{ padding: 8 }} disabled={!assetSrc}
              icon={isInAssets ? <StarFilled style={{ color: "#faad14" }} /> : <StarOutlined />}
              onClick={() => { if (!isInAssets) dispatchNodeAction(nodeId, "save-asset"); }} />
          </Tooltip>
          <Tooltip title={t("common.download")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DownloadOutlined />}
              onClick={() => dispatchNodeAction(nodeId, "download")} />
          </Tooltip>
          {/* 全屏预览按钮已移除：节点底部播放器自带足够控件，全屏入口冗余 */}
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("common.clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={16} />}
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
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={16} />}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}

      {/* Text node actions — 复制 / 下载为 Markdown，清除 */}
      {nodeType === NODE_ACTIONS.TEXT && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Tooltip title={t("common.copy")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<CopyOutlined />} disabled={!textContent}
              onClick={() => dispatchNodeAction(nodeId, "copy")} />
          </Tooltip>
          <Tooltip title={t("common.download")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<DownloadOutlined />} disabled={!textContent}
              onClick={() => dispatchNodeAction(nodeId, "download")} />
          </Tooltip>
          <Tooltip title={t("common.clear")}>
            <Button type="text" size="middle" style={{ padding: 8 }} icon={<Eraser size={16} />} disabled={!textContent}
              onClick={() => dispatchNodeAction(nodeId, "clear")} />
          </Tooltip>
        </>
      )}

      {/* Group node actions */}
      {nodeType === NODE_ACTIONS.GROUP && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <Popover
            trigger="click"
            placement="bottom"
            styles={{ container: { padding: 0, background: "transparent" } }}
            content={<GroupColorPicker nodeId={nodeId} current={groupColor} />}
          >
            <Tooltip title={t("node.groupColor")}>
              <Button
                type="text"
                size="middle"
                style={{ padding: 8, color: groupColor && groupColor !== "default" ? getGroupColor(groupColor).border : "#ffffff" }}
                icon={<BgColorsOutlined />}
              />
            </Tooltip>
          </Popover>
          <MenuPopover
            open={layoutOpen}
            onOpenChange={setLayoutOpen}
            placement="bottom"
            trigger={
              <Tooltip title={t("common.layout")}>
                <Button
                  type="text"
                  size="middle"
                  style={{ padding: 8 }}
                  icon={<GroupGridIcon />}
                />
              </Tooltip>
            }
            content={
              <>
                <MenuItem onClick={() => dispatchNodeAction(nodeId, "layout", { mode: "grid" })}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><GridSplitIcon style={{ fontSize: 16 }} /> {t("node.gridLayout")}</span>
                </MenuItem>
                <MenuItem onClick={() => dispatchNodeAction(nodeId, "layout", { mode: "horizontal" })}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><AlignHorizontalIcon style={{ fontSize: 16 }} /> {t("node.horizontalLayout")}</span>
                </MenuItem>
                <MenuItem onClick={() => dispatchNodeAction(nodeId, "layout", { mode: "vertical" })}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><AlignVerticalIcon style={{ fontSize: 16 }} /> {t("node.verticalLayout")}</span>
                </MenuItem>
              </>
            }
          />
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
        </>
      )}
    </div>
  );
}

export default memo(NodeToolbar);

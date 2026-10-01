/**
 * 节点悬浮工具条。
 * 按节点类型渲染对应操作（下载、裁剪、宫格切分、打光、多视角、翻转旋转、
 * 收藏到资产、删除等），操作本身不落地，统一通过自定义事件派发给节点组件执行。
 */
"use client";

import {
  CheckOutlined,
  DownloadOutlined,
  ExpandOutlined,
  InfoCircleOutlined,
  RotateRightOutlined,
  StarFilled,
  StarOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
} from "@ant-design/icons";
import { Copy, Crop, FlipHorizontal, FlipVertical, Wand2 } from "lucide-react";
import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import AppDropdown from "@/components/ui/AppDropdown";
import AppPopover from "@/components/ui/AppPopover";
import AppTooltip from "@/components/ui/AppTooltip";
import { ClipTrimIcon } from "@/components/ui/icons/canvas/ClipTrimIcon";
import { GridLayoutIcon } from "@/components/ui/icons/canvas/GridLayoutIcon";
import { GridSplitIcon } from "@/components/ui/icons/canvas/GridSplitIcon";
import { GroupGridIcon } from "@/components/ui/icons/canvas/GroupGridIcon";
import { HorizontalLayoutIcon } from "@/components/ui/icons/canvas/HorizontalLayoutIcon";
import { ImageAnnotationIcon } from "@/components/ui/icons/canvas/ImageAnnotationIcon";
import { ImageToPromptIcon } from "@/components/ui/icons/canvas/ImageToPromptIcon";
import { LightingIcon } from "@/components/ui/icons/canvas/LightingIcon";
import { MultiAngleIcon } from "@/components/ui/icons/canvas/MultiAngleIcon";
import { PanoramaIcon } from "@/components/ui/icons/canvas/PanoramaIcon";
import { SpeedIcon } from "@/components/ui/icons/canvas/SpeedIcon";
import { UngroupIcon } from "@/components/ui/icons/canvas/UngroupIcon";
import { VerticalLayoutIcon } from "@/components/ui/icons/canvas/VerticalLayoutIcon";
import { VideoToPromptIcon } from "@/components/ui/icons/canvas/VideoToPromptIcon";
import { FrameCaptureIcon } from "@/components/ui/icons/media/FrameCaptureIcon";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { useAssetsStore } from "@/features/assets/store";
import AudioSpeedPanel from "@/features/canvas/editing/AudioSpeedPanel";
import { dispatchNodeAction } from "@/features/canvas/shared/node-action";
import PresetMenuContent from "@/features/canvas/shared/PresetMenuContent";
import { usePromptTemplateCatalog } from "@/features/canvas/shared/prompt-presets";
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
  /** 打开帧序列面板（由画布层挂在节点下方，故需回抛给 InfiniteCanvas） */
  onOpenFrameStrip: (nodeId: string) => void;
  /** 打开片段截取面板（同上，画布层挂载；与帧序列面板互斥） */
  onOpenClipStrip: (nodeId: string) => void;
  /** 打开音频片段截取面板（同上，画布层挂载；与帧序列/片段截取互斥） */
  onOpenAudioClip: (nodeId: string) => void;
  /** 打开图片打光面板（同上，画布层挂载；与帧序列/片段截取/音频截取互斥） */
  onOpenLighting: (nodeId: string) => void;
}

/** 宫格切分选择器 — 鼠标划过高亮行列数，点击确认 */
function GridPicker({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState({ rows: 0, cols: 0 });
  const MAX = 5;
  return (
    <div className="flex flex-col gap-0.5">
      {[2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className="panel-item-btn"
          onClick={() => dispatchNodeAction(nodeId, "grid-split", { rows: n, cols: n })}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <GridSplitIcon style={{ fontSize: 16 }} />
            {n === 2 ? "4" : n === 3 ? "9" : n === 4 ? "16" : "25"}×{n}
          </span>
        </button>
      ))}
      <div className="panel-divider" />
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
                    background: active ? "var(--canvas-success)" : "var(--canvas-bg)",
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
      useCanvasStore.getState().updateNodeVisual(nodeId, {
        data: { color: key },
        immediate: true,
      });
    },
    [nodeId]
  );
  return (
    <div className="panel-popover">
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

/** 收藏 / 取消收藏切换按钮（图片 / 视频节点共用）。
    未收藏 = 空心星点击收藏；已收藏 = 实心星，再次点击从资产移除（toggle，
    文件引用是计数账本，画布节点的引用不受影响）。 */
function AssetStarButton({ nodeId, assetSrc }: { nodeId: string; assetSrc?: string }) {
  const { t } = useTranslation();
  const unsaveAssetsByUrls = useAssetsStore((s) => s.unsaveAssetsByUrls);
  const isInAssets = useAssetsStore((s) => !!assetSrc && s.knownAssetUrls.has(assetSrc));
  return (
    <AppTooltip title={isInAssets ? t("node.unsaveAsset") : t("node.addToAssets")}>
      <AppButton
        variant="ghost"
        iconOnly
        disabled={!assetSrc}
        onClick={() => {
          if (!assetSrc) return;
          if (isInAssets) void unsaveAssetsByUrls([assetSrc]);
          else dispatchNodeAction(nodeId, "save-asset");
        }}
      >
        {isInAssets ? <StarFilled style={{ color: "var(--canvas-warning)" }} /> : <StarOutlined />}
      </AppButton>
    </AppTooltip>
  );
}

function NodeToolbar({ nodeId, nodeType, onShowInspector, onOpenFrameStrip, onOpenClipStrip, onOpenAudioClip, onOpenLighting }: NodeToolbarProps) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const assetSrc = (nodes.find(n => n.id === nodeId)?.data as { src?: string })?.src;
  // 音轨探测结论：undefined = 尚未确定（按「可能有音轨」处理，真无音轨时由后端兜底）；
  // false = 确定无音轨，禁用分离入口
  const videoHasAudio = (nodes.find(n => n.id === nodeId)?.data as { hasAudio?: boolean })?.hasAudio;
  const textContent = (nodes.find(n => n.id === nodeId)?.data as { plainText?: string })?.plainText;
  const groupColor = (nodes.find(n => n.id === nodeId)?.data as { color?: string })?.color;
  // 变速调节模式：点变速按钮进入，滑杆调出目标倍率，✓ 交由服务端生成变速产物
  const [speedMode, setSpeedMode] = useState(false);
  const [speedDraft, setSpeedDraft] = useState(1);
  // 本节点处于音频片段截取中：常规工具栏隐藏（✓/✗ 在节点下方的 AudioClipStripPanel 内）
  const audioClipActive = useCanvasStore((s) => s.audioClipNodeId === nodeId);
  // 状态卫生：进入截取模式 / 切换到其它节点时退出变速调节（渲染期派生调整）
  const [prevNodeId, setPrevNodeId] = useState(nodeId);
  if (speedMode && (audioClipActive || prevNodeId !== nodeId)) {
    setSpeedMode(false);
  }
  if (prevNodeId !== nodeId) {
    setPrevNodeId(nodeId);
  }
  // 创作菜单与生成面板共用同一份后端模板目录与同一个分组菜单组件（图片节点取 image 预设）；
  // 反推提示词是独立动作，单独成按钮
  const { data: templateCatalog } = usePromptTemplateCatalog("image");
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
      {/* 音频变速调节态：信息按钮不参与调速，隐藏以保持工具栏聚焦 */}
      {!(nodeType === NODE_ACTIONS.AUDIO && speedMode) && (
        <AppTooltip title={t("common.info")}>
          <AppButton variant="ghost" iconOnly            style={{ padding: 8 }}
            onClick={handleInfo}
          ><InfoCircleOutlined /></AppButton>
        </AppTooltip>
      )}

      {/* Image node actions */}
      {nodeType === NODE_ACTIONS.IMAGE && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          {/* 全景 */}
          <AppTooltip title={t("node.panorama")}>
            <AppButton variant="ghost" iconOnly disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "panorama")} ><PanoramaIcon /></AppButton>
          </AppTooltip>
          {/* Edit */}
          <AppDropdown
            open={transformOpen}
            onOpenChange={setTransformOpen}
            placement="bottom"
            trigger={["click"]}
            menu={{
              items: [
                { key: "rot90", icon: <RotateRightOutlined style={{ fontSize: 16 }} />, label: t("node.rotate90") },
                { key: "flipH", icon: <FlipHorizontal size={16} />, label: t("node.flipH") },
                { key: "flipV", icon: <FlipVertical size={16} />, label: t("node.flipV") },
              ],
              onClick: ({ key }) => {
                if (key === "rot90") dispatchNodeAction(nodeId, "transform", { op: "rot90" });
                else if (key === "flipH") dispatchNodeAction(nodeId, "transform", { op: "flipH" });
                else if (key === "flipV") dispatchNodeAction(nodeId, "transform", { op: "flipV" });
              },
            }}
          >
            <AppTooltip title={t("node.transform")}>
              <AppButton variant="ghost" iconOnly disabled={!assetSrc} ><RotateRightOutlined /></AppButton>
            </AppTooltip>
          </AppDropdown>
          <AppTooltip title={t("node.crop")}>
            <AppButton variant="ghost" iconOnly disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "crop-interactive")} ><Crop size={16} /></AppButton>
          </AppTooltip>
          <AppTooltip title={t("annotation.title")}>
            <AppButton variant="ghost" iconOnly disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "annotate")} ><ImageAnnotationIcon style={{ fontSize: 16 }} /></AppButton>
          </AppTooltip>
          <AppPopover
            open={gridOpen}
            onOpenChange={setGridOpen}
            placement="bottom"
            trigger={["click"]}
            arrow={false}
            contentStyle={{ padding: 0, background: "transparent" }}
            content={
              <div className="panel-popover">
                <GridPicker nodeId={nodeId} />
              </div>
            }
          >
            <AppTooltip title={t("node.gridSplit")}>
              <AppButton variant="ghost" iconOnly disabled={!assetSrc}>
                <GridSplitIcon />
              </AppButton>
            </AppTooltip>
          </AppPopover>
          {/* AI */}
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <AppTooltip title={t("angle.editor")}>
            <AppButton variant="ghost" iconOnly              onClick={() => dispatchNodeAction(nodeId, "angle-editor")} disabled={!assetSrc} ><MultiAngleIcon /></AppButton>
          </AppTooltip>
          <AppTooltip title={t("lighting.title")}>
            <AppButton variant="ghost" iconOnly              onClick={() => onOpenLighting(nodeId)} disabled={!assetSrc} ><LightingIcon /></AppButton>
          </AppTooltip>
          <AppTooltip title={t("node.reversePrompt")}>
            <AppButton variant="ghost" iconOnly              onClick={() => dispatchNodeAction(nodeId, "create-template", { templateId: "reverse" })}
              disabled={!assetSrc} ><ImageToPromptIcon style={{ fontSize: 16 }} /></AppButton>
          </AppTooltip>
          <AppPopover
            open={creationOpen}
            onOpenChange={setCreationOpen}
            placement="bottomLeft"
            trigger={["click"]}
            arrow={false}
            popupClassName="creation-menu-popover"
            contentStyle={{ padding: 0, background: "transparent" }}
            content={
              <div className="panel-popover">
                <PresetMenuContent
                  catalog={templateCatalog}
                  onSelect={(presetId) => { setCreationOpen(false); dispatchNodeAction(nodeId, "create-template", { templateId: presetId }); }}
                />
              </div>
            }
          >
            <AppTooltip title={t("node.creation")}>
              <AppButton variant="ghost" iconOnly disabled={!assetSrc} ><Wand2 size={16} /></AppButton>
            </AppTooltip>
          </AppPopover>
          {/* Export */}
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <AssetStarButton nodeId={nodeId} assetSrc={assetSrc} />
          <AppTooltip title={t("common.download")}>
            <AppButton variant="ghost" iconOnly disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "download")} ><DownloadOutlined /></AppButton>
          </AppTooltip>
          <AppTooltip title={t("node.previewFullscreen")}>
            <AppButton variant="ghost" iconOnly disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "preview-fullscreen")} ><ExpandOutlined /></AppButton>
          </AppTooltip>
        </>
      )}

      {/* Video node actions */}
      {nodeType === NODE_ACTIONS.VIDEO && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <AppDropdown
            open={captureOpen}
            onOpenChange={setCaptureOpen}
            placement="bottom"
            trigger={["click"]}
            menu={{
              items: [
                { key: "current", icon: <FrameCaptureIcon style={{ fontSize: 16 }} />, label: t("capture.currentFrame") },
                { key: "first", icon: <StepBackwardOutlined style={{ fontSize: 16 }} />, label: t("capture.firstFrame") },
                { key: "last", icon: <StepForwardOutlined style={{ fontSize: 16 }} />, label: t("capture.lastFrame") },
              ],
              onClick: ({ key }) => {
                if (key === "current") onOpenFrameStrip(nodeId);
                else if (key === "first") dispatchNodeAction(nodeId, "capture-frame", { time: 0 });
                else if (key === "last") dispatchNodeAction(nodeId, "capture-frame", { time: -1 });
              },
            }}
          >
            <AppTooltip title={t("node.captureFrame")}>
              <AppButton variant="ghost" iconOnly disabled={!assetSrc} ><FrameCaptureIcon /></AppButton>
            </AppTooltip>
          </AppDropdown>
          {/* 片段截取：独立入口（与帧家族分开——产物是视频节点而非图片节点） */}
          <AppTooltip title={t("clip.menu")}>
            <AppButton variant="ghost" iconOnly              style={{ padding: 8 }}
              disabled={!assetSrc}
              onClick={() => onOpenClipStrip(nodeId)}
            ><ClipTrimIcon style={{ fontSize: 16 }} /></AppButton>
          </AppTooltip>
          {/* 画面裁剪：与图片节点同语义（源像素矩形重编码为派生视频） */}
          <AppTooltip title={t("node.crop")}>
            <AppButton variant="ghost" iconOnly              style={{ padding: 8 }}
              disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "crop-video")}
            ><Crop size={16} /></AppButton>
          </AppTooltip>
          <AppTooltip title={videoHasAudio === false ? t("node.detachAudioNoTrack") : t("node.detachAudio")}>
            <AppButton variant="ghost" iconOnly              style={{ padding: 8 }}
              disabled={!assetSrc || videoHasAudio === false}
              onClick={() => dispatchNodeAction(nodeId, "detach-audio")}
            ><WaveIcon /></AppButton>
          </AppTooltip>
          <AppTooltip title={t("node.reversePrompt")}>
            <AppButton variant="ghost" iconOnly              style={{ padding: 8 }}
              disabled={!assetSrc}
            ><VideoToPromptIcon style={{ fontSize: 16 }} /></AppButton>
          </AppTooltip>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <AssetStarButton nodeId={nodeId} assetSrc={assetSrc} />
          <AppTooltip title={t("common.download")}>
            <AppButton variant="ghost" iconOnly disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "download")} ><DownloadOutlined /></AppButton>
          </AppTooltip>
          <AppTooltip title={t("node.previewFullscreen")}>
            <AppButton variant="ghost" iconOnly disabled={!assetSrc}
              onClick={() => dispatchNodeAction(nodeId, "preview-fullscreen")} ><ExpandOutlined /></AppButton>
          </AppTooltip>
        </>
      )}

      {/* Audio node actions — 二态：变速调节 → 常规（片段截取/变速/下载）；
          音频片段截取中本工具栏整体隐藏（✓/✗ 在节点下方的 AudioClipStripPanel 内） */}
      {nodeType === NODE_ACTIONS.AUDIO && (
        <>
          {speedMode ? (
            <AudioSpeedPanel
              speed={speedDraft}
              onSpeedChange={(next) => setSpeedDraft(next)}
              onApply={() => {
                dispatchNodeAction(nodeId, "apply-audio-speed", { speed: speedDraft });
                setSpeedMode(false);
              }}
              onCancel={() => setSpeedMode(false)}
            />
          ) : (
            <>
              <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
              <AppTooltip title={t("clip.menu")}>
                <AppButton variant="ghost" iconOnly                  style={{ padding: 8 }}
                  disabled={!assetSrc}
                  onClick={() => onOpenAudioClip(nodeId)}
                ><ClipTrimIcon style={{ fontSize: 16 }} /></AppButton>
              </AppTooltip>
              <AppTooltip title={t("node.audioSpeed")}>
                <AppButton variant="ghost" iconOnly                  style={{ padding: 8 }}
                  disabled={!assetSrc}
                  onClick={() => {
                    setSpeedDraft(1);
                    setSpeedMode(true);
                  }}
                ><SpeedIcon /></AppButton>
              </AppTooltip>
              <AppTooltip title={t("common.download")}>
                <AppButton variant="ghost" iconOnly disabled={!assetSrc}
                  onClick={() => dispatchNodeAction(nodeId, "download")} ><DownloadOutlined /></AppButton>
              </AppTooltip>
            </>
          )}
        </>
      )}

      {/* Text node actions — 复制 / 下载为 Markdown */}
      {nodeType === NODE_ACTIONS.TEXT && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <AppTooltip title={t("common.copy")}>
            <AppButton variant="ghost" iconOnly disabled={!textContent}
              onClick={() => dispatchNodeAction(nodeId, "copy")} ><Copy size={16} /></AppButton>
          </AppTooltip>
          <AppTooltip title={t("common.download")}>
            <AppButton variant="ghost" iconOnly disabled={!textContent}
              onClick={() => dispatchNodeAction(nodeId, "download")} ><DownloadOutlined /></AppButton>
          </AppTooltip>
        </>
      )}

      {/* Group node actions */}
      {nodeType === NODE_ACTIONS.GROUP && (
        <>
          <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
          <AppPopover
            trigger="click"
            placement="bottom"
            contentStyle={{ padding: 0, background: "transparent" }}
            content={<GroupColorPicker nodeId={nodeId} current={groupColor} />}
          >
            <AppTooltip title={t("node.groupColor")}>
              <AppButton variant="ghost" iconOnly>
                <span
                  style={{
                    display: "block",
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: getGroupColor(groupColor).border,
                    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.25)",
                  }}
                />
              </AppButton>
            </AppTooltip>
          </AppPopover>
          <AppDropdown
            open={layoutOpen}
            onOpenChange={setLayoutOpen}
            placement="bottom"
            trigger={["click"]}
            menu={{
              items: [
                { key: "grid", icon: <GridLayoutIcon style={{ fontSize: 16 }} />, label: t("node.gridLayout") },
                { key: "horizontal", icon: <HorizontalLayoutIcon style={{ fontSize: 16 }} />, label: t("node.horizontalLayout") },
                { key: "vertical", icon: <VerticalLayoutIcon style={{ fontSize: 16 }} />, label: t("node.verticalLayout") },
              ],
              onClick: ({ key }) => {
                if (key === "grid") dispatchNodeAction(nodeId, "layout", { mode: "grid" });
                else if (key === "horizontal") dispatchNodeAction(nodeId, "layout", { mode: "horizontal" });
                else if (key === "vertical") dispatchNodeAction(nodeId, "layout", { mode: "vertical" });
              },
            }}
          >
            <AppTooltip title={t("common.layout")}>
              <AppButton variant="ghost" iconOnly                style={{ padding: 8 }}
              ><GroupGridIcon /></AppButton>
            </AppTooltip>
          </AppDropdown>
          <AppTooltip title={t("common.ungroup")}>
            <AppButton variant="ghost" iconOnly              style={{ padding: 8 }}
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent(EventNames.CANVAS_UNGROUP_NODES));
              }}
            ><UngroupIcon /></AppButton>
          </AppTooltip>
        </>
      )}
    </div>
  );
}

export default memo(NodeToolbar);

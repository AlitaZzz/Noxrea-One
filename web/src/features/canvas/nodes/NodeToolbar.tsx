/**
 * 节点悬浮工具条。
 * 按节点类型渲染对应操作（下载、裁剪、宫格切分、打光、多视角、翻转旋转、
 * 收藏到资产、删除等），操作本身不落地，统一通过自定义事件派发给节点组件执行。
 */
"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
} from "@/components/ui/AppIcon";
import { Copy, Crop, FlipHorizontal, FlipVertical, Wand2 } from "@/components/ui/AppIcon";
import { ClipTrimIcon } from "@/components/ui/AppIcon";
import { GridLayoutIcon } from "@/components/ui/AppIcon";
import { GridSplitIcon } from "@/components/ui/AppIcon";
import { GroupGridIcon } from "@/components/ui/AppIcon";
import { HorizontalLayoutIcon } from "@/components/ui/AppIcon";
import { ImageAnnotationIcon } from "@/components/ui/AppIcon";
import { ImageToPromptIcon } from "@/components/ui/AppIcon";
import { LightingIcon } from "@/components/ui/AppIcon";
import { MultiAngleIcon } from "@/components/ui/AppIcon";
import { PanoramaIcon } from "@/components/ui/AppIcon";
import { SpeedIcon } from "@/components/ui/AppIcon";
import { UngroupIcon } from "@/components/ui/AppIcon";
import { VerticalLayoutIcon } from "@/components/ui/AppIcon";
import { VideoToPromptIcon } from "@/components/ui/AppIcon";
import { FrameCaptureIcon } from "@/components/ui/AppIcon";
import { WaveIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  gridOpen: boolean;
  onGridOpenChange: (nodeId: string, open: boolean) => void;
  dismissSignal: number;
}

function GridPreview({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-7 shrink-0 gap-px rounded-[3px] border border-border/80 bg-border p-px"
      style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: size * size }).map((_, index) => (
        <span key={index} className="rounded-[1px] bg-muted-foreground/45" />
      ))}
    </span>
  );
}

/** 宫格切分选择器 — 常用尺寸快捷入口与自定义行列选择 */
function GridPicker({ nodeId, onSelect }: { nodeId: string; onSelect: () => void }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState({ rows: 0, cols: 0 });
  const MAX = 5;
  const updateHover = useCallback((rows: number, cols: number) => {
    setHover((current) => current.rows === rows && current.cols === cols ? current : { rows, cols });
  }, []);
  const handleGridPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const cell = target.closest<HTMLButtonElement>('[data-grid-cell="true"]');
    if (!cell || !event.currentTarget.contains(cell)) return;
    updateHover(Number(cell.dataset.row), Number(cell.dataset.col));
  }, [updateHover]);
  const handleSelect = useCallback(
    (rows: number, cols: number) => {
      dispatchNodeAction(nodeId, "grid-split", { rows, cols });
      onSelect();
    },
    [nodeId, onSelect]
  );
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-medium">{t("node.gridSplit")}</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
      {[2, 3, 4, 5].map((n) => (
        <Button
          key={n}
          type="button"
          variant="outline"
          size="sm"
          className="h-14 justify-start gap-2 rounded-lg border-border/70 bg-background/60 px-2.5 font-normal shadow-none hover:bg-accent hover:text-accent-foreground"
          onClick={() => handleSelect(n, n)}
        >
          <GridPreview size={n} />
          <span className="flex min-w-0 flex-col items-start gap-0.5">
            <span className="text-sm">{n}×{n}</span>
            <span className="text-[11px] text-muted-foreground">{n * n}</span>
          </span>
        </Button>
      ))}
      </div>
      <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">{t("node.gridCustom")}</span>
          <span className="rounded-md bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {hover.rows > 0 && hover.cols > 0 ? `${hover.rows}×${hover.cols}` : t("node.gridSelect")}
          </span>
        </div>
        <div className="flex justify-center rounded-md border border-border/70 bg-background p-2">
          <div
            className="inline-grid gap-px rounded-sm border border-border bg-border p-px"
            style={{ gridTemplateColumns: `repeat(${MAX}, 16px)` }}
            onPointerMove={handleGridPointerMove}
            onPointerLeave={() => setHover({ rows: 0, cols: 0 })}
          >
            {Array.from({ length: MAX * MAX }).map((_, i) => {
              const row = Math.floor(i / MAX) + 1;
              const col = (i % MAX) + 1;
              const active = row <= hover.rows && col <= hover.cols;
              return (
                <Button
                  key={i}
                  type="button"
                  variant={active ? "default" : "ghost"}
                  size="icon-xs"
                  data-grid-cell="true"
                  data-row={row}
                  data-col={col}
                  aria-label={`${row}×${col}`}
                  onFocus={() => updateHover(row, col)}
                  onClick={() => handleSelect(row, col)}
                  className={`size-4 rounded-[1px] border-0 p-0 transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring ${active ? "hover:bg-primary" : "bg-muted hover:bg-accent"}`}
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
    <div className="flex flex-col gap-2">
      <div className="px-1 text-xs text-muted-foreground">{t("node.groupColor")}</div>
      <div className="grid grid-cols-5 gap-2">
        {GROUP_COLOR_KEYS.map((key) => {
          const preset = GROUP_COLORS[key];
          const isDefault = key === "default";
          const selected = (current ?? DEFAULT_GROUP_COLOR_KEY) === key;
          return (
            <Button
              key={key}
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => handlePick(key)}
              className="relative size-[26px] rounded-full p-0 transition-transform hover:scale-110"
              style={{
                border: `2px solid ${preset.border}`,
                background: isDefault ? "transparent" : preset.fill,
                boxShadow: selected ? `0 0 0 2px var(--card), 0 0 0 3px ${preset.border}` : "none",
              }}
            >
              {isDefault && (
                <span
                  className="absolute h-0.5 w-5 rotate-45 rounded-[1px] bg-muted-foreground"
                />
              )}
              {selected && !isDefault && (
                <CheckOutlined className="size-3" style={{ color: preset.border }} />
              )}
            </Button>
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
    <Tooltip><TooltipTrigger asChild>
        <Button
          variant="ghost"
          iconOnly
          disabled={!assetSrc}
          onClick={() => {
            if (!assetSrc) return;
            if (isInAssets) void unsaveAssetsByUrls([assetSrc]);
            else dispatchNodeAction(nodeId, "save-asset");
          }}
        >
          {isInAssets ? <StarFilled style={{ color: "var(--chart-4)" }} /> : <StarOutlined />}
        </Button>
      </TooltipTrigger><TooltipContent>{isInAssets ? t("node.unsaveAsset") : t("node.addToAssets")}</TooltipContent></Tooltip>
  );
}

function NodeToolbar({
  nodeId,
  nodeType,
  onShowInspector,
  onOpenFrameStrip,
  onOpenClipStrip,
  onOpenAudioClip,
  onOpenLighting,
  gridOpen,
  onGridOpenChange,
  dismissSignal,
}: NodeToolbarProps) {
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
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [groupColorOpen, setGroupColorOpen] = useState(false);
  const dismissFocusRef = useRef(false);
  const previousDismissSignal = useRef(dismissSignal);
  const resetDismissFocus = useCallback(() => {
    dismissFocusRef.current = false;
  }, []);
  const handleMenuCloseAutoFocus = useCallback((event: Event) => {
    if (dismissFocusRef.current) {
      dismissFocusRef.current = false;
      event.preventDefault();
    }
  }, []);

  useEffect(() => {
    if (previousDismissSignal.current === dismissSignal) return;
    previousDismissSignal.current = dismissSignal;
    dismissFocusRef.current = true;
    setCreationOpen(false);
    setTransformOpen(false);
    setLayoutOpen(false);
    setCaptureOpen(false);
    setGroupColorOpen(false);
    onGridOpenChange(nodeId, false);
  }, [dismissSignal, nodeId, onGridOpenChange]);
  const handleInfo = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onShowInspector(nodeId);
    },
    [nodeId, onShowInspector]
  );

  return (
    <div
      className="canvas-toolbar z-20 flex h-[50px] items-center gap-1 whitespace-nowrap rounded-xl px-2.5 py-1.5"
    >
      {/* 音频变速调节态：信息按钮不参与调速，隐藏以保持工具栏聚焦 */}
      {!(nodeType === NODE_ACTIONS.AUDIO && speedMode) && (
        <Tooltip><TooltipTrigger asChild>
            <Button variant="ghost" iconOnly
              onClick={handleInfo}
            ><InfoCircleOutlined /></Button>
          </TooltipTrigger><TooltipContent>{t("common.info")}</TooltipContent></Tooltip>
      )}

      {/* Image node actions */}
      {nodeType === NODE_ACTIONS.IMAGE && (
        <>
          <div className="mx-1 h-5 w-px bg-border" />
          {/* 全景 */}
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly disabled={!assetSrc}
                onClick={() => dispatchNodeAction(nodeId, "panorama")} ><PanoramaIcon /></Button>
            </TooltipTrigger><TooltipContent>{t("node.panorama")}</TooltipContent></Tooltip>
          {/* Edit */}
          <DropdownMenu open={transformOpen} onOpenChange={(open) => {
            if (open) resetDismissFocus();
            setTransformOpen(open);
          }}>
            <Tooltip><TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" iconOnly disabled={!assetSrc}><RotateRightOutlined /></Button>
                </DropdownMenuTrigger>
              </TooltipTrigger><TooltipContent>{t("node.transform")}</TooltipContent></Tooltip>
            <DropdownMenuContent side="bottom" align="center" onCloseAutoFocus={handleMenuCloseAutoFocus}>
              <DropdownMenuItem onSelect={() => dispatchNodeAction(nodeId, "transform", { op: "rot90" })}>
                <RotateRightOutlined />{t("node.rotate90")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => dispatchNodeAction(nodeId, "transform", { op: "flipH" })}>
                <FlipHorizontal />{t("node.flipH")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => dispatchNodeAction(nodeId, "transform", { op: "flipV" })}>
                <FlipVertical />{t("node.flipV")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly disabled={!assetSrc}
                onClick={() => dispatchNodeAction(nodeId, "crop-interactive")} ><Crop size={16} /></Button>
            </TooltipTrigger><TooltipContent>{t("node.crop")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly disabled={!assetSrc}
                onClick={() => dispatchNodeAction(nodeId, "annotate")} ><ImageAnnotationIcon style={{ fontSize: 16 }} /></Button>
            </TooltipTrigger><TooltipContent>{t("annotation.title")}</TooltipContent></Tooltip>
          <Popover
            open={gridOpen}
            onOpenChange={(open) => {
              if (open) resetDismissFocus();
              onGridOpenChange(nodeId, open);
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button variant="ghost" iconOnly disabled={!assetSrc}>
                    <GridSplitIcon />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("node.gridSplit")}</TooltipContent>
            </Tooltip>
            <PopoverContent
              side="bottom"
              align="center"
              className="w-80 max-w-[calc(100vw-2rem)] p-3"
              onCloseAutoFocus={handleMenuCloseAutoFocus}
            >
              <GridPicker nodeId={nodeId} onSelect={() => onGridOpenChange(nodeId, false)} />
            </PopoverContent>
          </Popover>
          {/* AI */}
          <div className="mx-1 h-5 w-px bg-border" />
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly              onClick={() => dispatchNodeAction(nodeId, "angle-editor")} disabled={!assetSrc} ><MultiAngleIcon /></Button>
            </TooltipTrigger><TooltipContent>{t("angle.editor")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly              onClick={() => onOpenLighting(nodeId)} disabled={!assetSrc} ><LightingIcon /></Button>
            </TooltipTrigger><TooltipContent>{t("lighting.title")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly              onClick={() => dispatchNodeAction(nodeId, "create-template", { templateId: "reverse" })}
                disabled={!assetSrc} ><ImageToPromptIcon style={{ fontSize: 16 }} /></Button>
            </TooltipTrigger><TooltipContent>{t("node.reversePrompt")}</TooltipContent></Tooltip>
          <Popover
            open={creationOpen}
            onOpenChange={(open) => {
              if (open) resetDismissFocus();
              setCreationOpen(open);
            }}
          >
            <Tooltip open={creationOpen ? false : undefined}>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button variant="ghost" iconOnly disabled={!assetSrc}>
                    <Wand2 size={16} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("node.creation")}</TooltipContent>
            </Tooltip>
            <PopoverContent side="bottom" align="start" className="w-auto max-w-[min(90vw,48rem)] p-1" onCloseAutoFocus={handleMenuCloseAutoFocus}>
              <PresetMenuContent
                catalog={templateCatalog}
                onSelect={(presetId) => { setCreationOpen(false); dispatchNodeAction(nodeId, "create-template", { templateId: presetId }); }}
              />
            </PopoverContent>
          </Popover>
          {/* Export */}
          <div className="mx-1 h-5 w-px bg-border" />
          <AssetStarButton nodeId={nodeId} assetSrc={assetSrc} />
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly disabled={!assetSrc}
                onClick={() => dispatchNodeAction(nodeId, "download")} ><DownloadOutlined /></Button>
            </TooltipTrigger><TooltipContent>{t("common.download")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly disabled={!assetSrc}
                onClick={() => dispatchNodeAction(nodeId, "preview-fullscreen")} ><ExpandOutlined /></Button>
            </TooltipTrigger><TooltipContent>{t("node.previewFullscreen")}</TooltipContent></Tooltip>
        </>
      )}

      {/* Video node actions */}
      {nodeType === NODE_ACTIONS.VIDEO && (
        <>
          <div className="mx-1 h-5 w-px bg-border" />
          <DropdownMenu open={captureOpen} onOpenChange={(open) => {
            if (open) resetDismissFocus();
            setCaptureOpen(open);
          }}>
            <Tooltip><TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" iconOnly disabled={!assetSrc}><FrameCaptureIcon /></Button>
                </DropdownMenuTrigger>
              </TooltipTrigger><TooltipContent>{t("node.captureFrame")}</TooltipContent></Tooltip>
            <DropdownMenuContent side="bottom" align="center" onCloseAutoFocus={handleMenuCloseAutoFocus}>
              <DropdownMenuItem onSelect={() => onOpenFrameStrip(nodeId)}>
                <FrameCaptureIcon />{t("capture.currentFrame")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => dispatchNodeAction(nodeId, "capture-frame", { time: 0 })}>
                <StepBackwardOutlined />{t("capture.firstFrame")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => dispatchNodeAction(nodeId, "capture-frame", { time: -1 })}>
                <StepForwardOutlined />{t("capture.lastFrame")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* 片段截取：独立入口（与帧家族分开——产物是视频节点而非图片节点） */}
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly
                disabled={!assetSrc}
                onClick={() => onOpenClipStrip(nodeId)}
              ><ClipTrimIcon style={{ fontSize: 16 }} /></Button>
            </TooltipTrigger><TooltipContent>{t("clip.menu")}</TooltipContent></Tooltip>
          {/* 画面裁剪：与图片节点同语义（源像素矩形重编码为派生视频） */}
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly
                disabled={!assetSrc}
                onClick={() => dispatchNodeAction(nodeId, "crop-video")}
              ><Crop size={16} /></Button>
            </TooltipTrigger><TooltipContent>{t("node.crop")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly
                disabled={!assetSrc || videoHasAudio === false}
                onClick={() => dispatchNodeAction(nodeId, "detach-audio")}
              ><WaveIcon /></Button>
            </TooltipTrigger><TooltipContent>{videoHasAudio === false ? t("node.detachAudioNoTrack") : t("node.detachAudio")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly
                disabled={!assetSrc}
              ><VideoToPromptIcon style={{ fontSize: 16 }} /></Button>
            </TooltipTrigger><TooltipContent>{t("node.reversePrompt")}</TooltipContent></Tooltip>
          <div className="mx-1 h-5 w-px bg-border" />
          <AssetStarButton nodeId={nodeId} assetSrc={assetSrc} />
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly disabled={!assetSrc}
                onClick={() => dispatchNodeAction(nodeId, "download")} ><DownloadOutlined /></Button>
            </TooltipTrigger><TooltipContent>{t("common.download")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly disabled={!assetSrc}
                onClick={() => dispatchNodeAction(nodeId, "preview-fullscreen")} ><ExpandOutlined /></Button>
            </TooltipTrigger><TooltipContent>{t("node.previewFullscreen")}</TooltipContent></Tooltip>
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
              <div className="mx-1 h-5 w-px bg-border" />
              <Tooltip><TooltipTrigger asChild>
                  <Button variant="ghost" iconOnly
                    disabled={!assetSrc}
                    onClick={() => onOpenAudioClip(nodeId)}
                  ><ClipTrimIcon style={{ fontSize: 16 }} /></Button>
                </TooltipTrigger><TooltipContent>{t("clip.menu")}</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild>
                  <Button variant="ghost" iconOnly
                    disabled={!assetSrc}
                    onClick={() => {
                      setSpeedDraft(1);
                      setSpeedMode(true);
                    }}
                  ><SpeedIcon /></Button>
                </TooltipTrigger><TooltipContent>{t("node.audioSpeed")}</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild>
                  <Button variant="ghost" iconOnly disabled={!assetSrc}
                    onClick={() => dispatchNodeAction(nodeId, "download")} ><DownloadOutlined /></Button>
                </TooltipTrigger><TooltipContent>{t("common.download")}</TooltipContent></Tooltip>
            </>
          )}
        </>
      )}

      {/* Text node actions — 复制 / 下载为 Markdown */}
      {nodeType === NODE_ACTIONS.TEXT && (
        <>
          <div className="mx-1 h-5 w-px bg-border" />
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly disabled={!textContent}
                onClick={() => dispatchNodeAction(nodeId, "copy")} ><Copy size={16} /></Button>
            </TooltipTrigger><TooltipContent>{t("common.copy")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly disabled={!textContent}
                onClick={() => dispatchNodeAction(nodeId, "download")} ><DownloadOutlined /></Button>
            </TooltipTrigger><TooltipContent>{t("common.download")}</TooltipContent></Tooltip>
        </>
      )}

      {/* Group node actions */}
      {nodeType === NODE_ACTIONS.GROUP && (
        <>
          <div className="mx-1 h-5 w-px bg-border" />
          <Popover open={groupColorOpen} onOpenChange={(open) => {
            if (open) resetDismissFocus();
            setGroupColorOpen(open);
          }}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button variant="ghost" iconOnly>
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
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("node.groupColor")}</TooltipContent>
            </Tooltip>
            <PopoverContent side="bottom" align="center" className="w-auto p-2" onCloseAutoFocus={handleMenuCloseAutoFocus}>
              <GroupColorPicker nodeId={nodeId} current={groupColor} />
            </PopoverContent>
          </Popover>
          <DropdownMenu open={layoutOpen} onOpenChange={(open) => {
            if (open) resetDismissFocus();
            setLayoutOpen(open);
          }}>
            <Tooltip><TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" iconOnly><GroupGridIcon /></Button>
                </DropdownMenuTrigger>
              </TooltipTrigger><TooltipContent>{t("common.layout")}</TooltipContent></Tooltip>
            <DropdownMenuContent side="bottom" align="center" onCloseAutoFocus={handleMenuCloseAutoFocus}>
              <DropdownMenuItem onSelect={() => dispatchNodeAction(nodeId, "layout", { mode: "grid" })}>
                <GridLayoutIcon />{t("node.gridLayout")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => dispatchNodeAction(nodeId, "layout", { mode: "horizontal" })}>
                <HorizontalLayoutIcon />{t("node.horizontalLayout")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => dispatchNodeAction(nodeId, "layout", { mode: "vertical" })}>
                <VerticalLayoutIcon />{t("node.verticalLayout")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" iconOnly
                onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(new CustomEvent(EventNames.CANVAS_UNGROUP_NODES));
                }}
              ><UngroupIcon /></Button>
            </TooltipTrigger><TooltipContent>{t("common.ungroup")}</TooltipContent></Tooltip>
        </>
      )}
    </div>
  );
}

export default memo(NodeToolbar);

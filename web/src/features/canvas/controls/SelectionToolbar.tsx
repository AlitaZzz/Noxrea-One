/**
 * 多选聚合工具条：≥2 个节点选中且交互空闲时，替代每个选中节点各挂一条的
 * NodeToolbarUI。业务规则见 specs/canvas-multi-selection-toolbar.md。
 *
 * 分层：
 * - SelectionToolbar 只负责展示与回调，不订阅画布状态；
 * - SelectionToolbarLayer 订阅视口，把选区可见容器外框（flow 坐标）投影为屏幕坐标，
 *   并用 Panel 渲染在画布容器的屏幕层，尺寸不随缩放变化。
 *
 * 工具条只承载现有动作入口（编组 / 解组 / 创建副本 / 复制 / 删除），不复制
 * 动作实现；可见性仍由 canvasInteraction.showSelectionToolbars 统一门控。
 */
"use client";

import { Panel, useStore, useViewport } from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CopyOutlined,
  DeleteOutlined,
  DuplicateIcon,
  EllipsisOutlined,
  GroupIcon,
  UngroupIcon,
} from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import type { SelectionChromeBounds } from "@/features/canvas/shared/canvas-derived";
import { copySelection, deleteSelection, duplicateSelection } from "@/features/canvas/shared/canvas-edit-actions";
import type { Rect } from "@/features/canvas/shared/geometry";
import { EventNames } from "@/lib/constants";

/** 工具条与选区包围盒的固定视觉间距（屏幕像素） */
const SELECTION_TOOLBAR_GAP = 12;
/** 工具条与画布视口边缘的最小留白 */
const SELECTION_TOOLBAR_VIEWPORT_EDGE = 8;
/**
 * 顶部安全内边距：左上项目工具条 = 30px 内边距 + 36px 卡片高度 + 8px 间距。
 * 工具条优先放在选区上方；上方落进这个区域时改放下方，避免遮住项目工具条。
 */
const SELECTION_TOOLBAR_TOP_INSET = 74;

interface SelectionToolbarProps {
  count: number;
  hasGroup: boolean;
  /**
   * 选区签名（排序后的 id 拼接）。作为「更多」菜单的 key：变化时菜单重挂载并
   * 关闭，避免对旧选区执行动作；不重挂载整个展示层，否则 aria-live 计数节点
   * 会随选区变化重建，读屏无法播报。
   */
  selectionKey: string;
  onGroup: () => void;
  onUngroup: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

export const SelectionToolbar = memo(function SelectionToolbar({
  count,
  hasGroup,
  selectionKey,
  onGroup,
  onUngroup,
  onDuplicate,
  onCopy,
  onDelete,
}: SelectionToolbarProps) {
  const { t } = useTranslation();

  return (
    <Card
      className="nodrag nopan pointer-events-auto flex min-h-[50px] flex-row flex-wrap items-center gap-1 whitespace-nowrap rounded-xl px-2.5 py-1.5"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span aria-live="polite" className="px-1.5 text-sm text-muted-foreground">
        {t("canvas.selection.count", { count })}
      </span>
      <Separator orientation="vertical" className="mx-1 h-5 self-center" />
      {hasGroup ? (
        <Button size="sm" variant="ghost" onClick={onUngroup}>
          <UngroupIcon style={{ width: 16, height: 16 }} />
          {t("common.ungroup")}
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={onGroup}>
          <GroupIcon style={{ width: 16, height: 16 }} />
          {t("common.group")}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onDuplicate}>
        <DuplicateIcon style={{ width: 16, height: 16 }} />
        {t("common.duplicate")}
      </Button>
      <DropdownMenu key={selectionKey}>
        {/* 这里刻意不用 Tooltip：Radix Tooltip 在焦点回到触发器时会立即打开，
            并用 preventDefault 吞掉下一次 Esc，破坏「第一次 Esc 关菜单、第二次 Esc
            清空选区」的约定。title 提供悬停提示，aria-label 提供可访问名称。 */}
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.moreActions")}
            title={t("common.moreActions")}
          >
            <EllipsisOutlined />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="center">
          <DropdownMenuItem onSelect={onCopy}>
            <CopyOutlined />
            {t("common.copy")}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <DeleteOutlined />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Card>
  );
});

export interface SelectionToolbarPlacementInput {
  /** 定位锚点：选区外框顶部再加标题带，工具条与组标题保持距离。 */
  anchorBounds: Rect;
  /** 选区原始并集：只按它与视口的交集决定工具条是否出现。 */
  visibleBounds: Rect;
  viewport: { x: number; y: number; zoom: number };
  viewportSize: { width: number; height: number };
  toolbarSize: { width: number; height: number };
}

export interface SelectionToolbarPlacement {
  left: number;
  top: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 把选区投影到屏幕坐标并求工具条位置。
 *
 * - 可见性只看 visibleBounds（选区节点并集）：节点完全离开视口即隐藏，
 *   标题带与外框内边距都不算可见内容；
 * - 位置以 anchorBounds 为基准（顶部多一条标题带），避免组标题与工具条相撞；
 * - 上方放得下（且不进入顶部安全区）优先放上方，否则放下方；
 * - 两边都放不下时钳制在视口内；
 * - 水平居中，左右各留至少 8px。
 *
 * 纯函数，坐标全部为画布容器内的屏幕像素；尺寸参数由 ResizeObserver 实测，
 * 因此工具条宽度变化后无需猜测文案宽度。
 */
export function computeSelectionToolbarPlacement({
  anchorBounds,
  visibleBounds,
  viewport,
  viewportSize,
  toolbarSize,
}: SelectionToolbarPlacementInput): SelectionToolbarPlacement | null {
  const visibleLeft = visibleBounds.x * viewport.zoom + viewport.x;
  const visibleTop = visibleBounds.y * viewport.zoom + viewport.y;
  const visibleWidth = visibleBounds.width * viewport.zoom;
  const visibleHeight = visibleBounds.height * viewport.zoom;

  const intersectsViewport =
    visibleLeft + visibleWidth > 0 &&
    visibleTop + visibleHeight > 0 &&
    visibleLeft < viewportSize.width &&
    visibleTop < viewportSize.height;
  if (!intersectsViewport) return null;

  const screenLeft = anchorBounds.x * viewport.zoom + viewport.x;
  const screenTop = anchorBounds.y * viewport.zoom + viewport.y;
  const screenWidth = anchorBounds.width * viewport.zoom;
  const screenHeight = anchorBounds.height * viewport.zoom;

  const maxLeft = Math.max(
    SELECTION_TOOLBAR_VIEWPORT_EDGE,
    viewportSize.width - toolbarSize.width - SELECTION_TOOLBAR_VIEWPORT_EDGE,
  );
  const left = clamp(
    screenLeft + screenWidth / 2 - toolbarSize.width / 2,
    SELECTION_TOOLBAR_VIEWPORT_EDGE,
    maxLeft,
  );

  const above = screenTop - toolbarSize.height - SELECTION_TOOLBAR_GAP;
  const below = screenTop + screenHeight + SELECTION_TOOLBAR_GAP;
  const maxTop = Math.max(
    SELECTION_TOOLBAR_TOP_INSET,
    viewportSize.height - toolbarSize.height - SELECTION_TOOLBAR_VIEWPORT_EDGE,
  );
  const top =
    above >= SELECTION_TOOLBAR_TOP_INSET
      ? above
      : below <= maxTop
        ? below
        : clamp(below, SELECTION_TOOLBAR_TOP_INSET, maxTop);

  return { left: Math.round(left), top: Math.round(top) };
}

interface SelectionToolbarLayerProps {
  bounds: SelectionChromeBounds;
  /** 选区签名（排序后的 id 拼接），变化时由展示层关闭「更多」菜单。 */
  selectionKey: string;
}

export function SelectionToolbarLayer({ bounds, selectionKey }: SelectionToolbarLayerProps) {
  const viewport = useViewport();
  const viewportWidth = useStore((state) => state.width);
  const viewportHeight = useStore((state) => state.height);
  const [toolbarSize, setToolbarSize] = useState<{ width: number; height: number } | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = measureRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setToolbarSize((previous) =>
        previous &&
        Math.abs(previous.width - rect.width) < 0.5 &&
        Math.abs(previous.height - rect.height) < 0.5
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 可见性按选区节点并集判定；定位锚点再向外扩 40px、顶部多留 28px 标题带，
  // 给编组后的组标题让位。全组选区外框隐藏时锚点等于并集。
  const placement = useMemo(
    () =>
      toolbarSize
        ? computeSelectionToolbarPlacement({
            anchorBounds: bounds.containerBbox,
            visibleBounds: bounds.bbox,
            viewport,
            viewportSize: { width: viewportWidth, height: viewportHeight },
            toolbarSize,
          })
        : null,
    [bounds.containerBbox, bounds.bbox, viewport, viewportWidth, viewportHeight, toolbarSize],
  );

  const handleGroup = useCallback(() => {
    window.dispatchEvent(new CustomEvent(EventNames.CANVAS_GROUP_NODES));
  }, []);
  const handleUngroup = useCallback(() => {
    window.dispatchEvent(new CustomEvent(EventNames.CANVAS_UNGROUP_NODES));
  }, []);
  const handleDuplicate = useCallback(() => {
    duplicateSelection();
  }, []);
  const handleCopy = useCallback(() => {
    copySelection();
  }, []);
  const handleDelete = useCallback(() => {
    deleteSelection();
  }, []);

  return (
    <Panel
      position="top-left"
      style={{ margin: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    >
      <div
        ref={measureRef}
        className="absolute"
        style={{
          left: placement?.left ?? 0,
          top: placement?.top ?? 0,
          maxWidth:
            viewportWidth > 0
              ? Math.max(0, viewportWidth - SELECTION_TOOLBAR_VIEWPORT_EDGE * 2)
              : undefined,
          visibility: placement ? "visible" : "hidden",
        }}
      >
        <SelectionToolbar
          count={bounds.count}
          hasGroup={bounds.hasGroup}
          selectionKey={selectionKey}
          onGroup={handleGroup}
          onUngroup={handleUngroup}
          onDuplicate={handleDuplicate}
          onCopy={handleCopy}
          onDelete={handleDelete}
        />
      </div>
    </Panel>
  );
}

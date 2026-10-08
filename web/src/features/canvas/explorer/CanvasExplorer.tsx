/**
 * 画布资源管理器（Explorer）。
 * 上半部为节点大纲：按类型分组列出画布节点，支持搜索、筛选与定位选中；
 * 下半部为资产快捷区：分页浏览资产文件夹与素材，支持悬浮预览并拖入画布成节点。
 * 通过 shadcn Sheet 实现，不绑定具体方位，可在主题层调整为左 / 右 / 上下布局。
 */

"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AppstoreOutlined,
  ClockCircleOutlined,
  DownOutlined,
  FolderOpenOutlined,
  LoadingOutlined,
  RightOutlined,
  VideoCameraOutlined,
} from "@/components/ui/AppIcon";
import { AssetsIcon } from "@/components/ui/AppIcon";
import { FilterIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyMedia } from "@/components/ui/empty";
import { SearchInput } from "@/components/ui/input-group";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { createAssetNode } from "@/features/assets/add-asset";
import AssetBreadcrumb from "@/features/assets/components/AssetBreadcrumb";
import AssetGrid from "@/features/assets/components/AssetGrid";
import { AssetHoverPreview } from "@/features/assets/components/AssetHoverPreview";
import { useAssetLibrary } from "@/features/assets/hooks/use-asset-library";
import { computeRecursiveFolderCounts, selectChildFolders, useAssetsStore } from "@/features/assets/store";
import type { AssetFolder, AssetItem, AssetType } from "@/features/assets/types";
import { getNodeTypeColor, getNodeTypeIcon, NODE_TYPE_I18N } from "@/features/canvas/NodeTypeDisplayMeta";
import { getCanvasDerived } from "@/features/canvas/shared/canvas-derived";
import { useCenterNode } from "@/features/canvas/shared/center-node";
import { findFreePosition, getViewportCenter, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode, TaskBinding, UploadState } from "@/features/canvas/types";
import { ASSET_CATEGORIES, isGenerating, NODE_TYPE } from "@/lib/constants";
import { formatBytes, formatDateTime, formatTime } from "@/lib/utils/format";

export const DRAWER_WIDTH = 360;

/** 元素树每层缩进宽度，同时用作组折叠箭头槽位宽度，保证各组/节点图标垂直对齐 */
const ROW_INDENT = 24;

interface CanvasExplorerProps {
  open: boolean;
  onClose: () => void;
}

export default function CanvasExplorer({ open, onClose }: CanvasExplorerProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<string>("elements");

  return (
    <Sheet
      open={open}
      modal={false}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
    >
      <SheetContent
        side="left"
        showOverlay={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="w-[360px] max-w-[100vw] gap-0 border-r border-border bg-card p-0"
      >
        <div className="flex min-h-0 flex-1 flex-col select-none">
          <SheetHeader>
            <SheetTitle>{t("canvas.sidebar")}</SheetTitle>
            <SheetDescription>{t("canvas.sidebarDescription")}</SheetDescription>
          </SheetHeader>
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex min-h-0 flex-1 flex-col gap-2"
          >
            <TabsList
              variant="line"
              className="w-full shrink-0 rounded-none p-0"
            >
              <TabsTrigger value="elements" className="h-auto rounded-none py-2">
                <AppstoreOutlined />
                {t("canvas.tab.elements")}
              </TabsTrigger>
              <TabsTrigger value="assets" className="h-auto rounded-none py-2">
                <AssetsIcon />
                {t("canvas.tab.assets")}
              </TabsTrigger>
            </TabsList>

            {/* forceMount 保留两个视图的搜索、分页和文件夹状态 */}
            <TabsContent value="elements" forceMount className="min-h-0 w-full data-[state=inactive]:hidden">
              <CanvasElementsView />
            </TabsContent>
            <TabsContent value="assets" forceMount className="min-h-0 w-full data-[state=inactive]:hidden">
              <AssetsView />
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
// ── 元素视图 ──

function CanvasElementsView() {
  const { t } = useTranslation();
  const outline = useCanvasStore((s) => getCanvasDerived(s.nodes, s.edges).outline);
  const selectedNodeIds = useCanvasStore((s) => getCanvasDerived(s.nodes, s.edges).selectedNodeIds);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const tree = outline;

  // 搜索过滤：命中标题 / 正文 / 生成 prompt / 类型名；组名命中保留全部成员，
  // 否则只保留命中的成员，无命中的组整体隐藏。
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tree;
    const matches = (n: AnyNode) => {
      const d = n.data as { label?: string; plainText?: string; genSettings?: { prompt?: string } };
      const typeKey = NODE_TYPE_I18N[n.type || ""];
      return [d.label, d.plainText, d.genSettings?.prompt, typeKey ? t(typeKey) : ""].some(
        (v) => typeof v === "string" && v.toLowerCase().includes(q),
      );
    };
    const groupEntries: Array<{ group: AnyNode; members: AnyNode[] }> = [];
    for (const g of tree.groupNodes) {
      const members = tree.membersByGroup.get(g.id) ?? [];
      const rawLabel = ((g.data as { label?: string }).label || "").toLowerCase();
      if (rawLabel.includes(q)) groupEntries.push({ group: g, members });
      else {
        const hit = members.filter(matches);
        if (hit.length > 0) groupEntries.push({ group: g, members: hit });
      }
    }
    return {
      groupNodes: groupEntries.map((e) => e.group),
      membersByGroup: new Map(groupEntries.map((e) => [e.group.id, e.members])),
      ungroupedGroups: tree.ungroupedGroups
        .map(({ type, nodes: list }) => ({ type, nodes: list.filter(matches) }))
        .filter((g) => g.nodes.length > 0),
    };
  }, [search, tree, t]);

  const hasMatch = visible.groupNodes.length > 0 || visible.ungroupedGroups.length > 0;

  const toggleGroup = useCallback((id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* 搜索：与资产页同规格（高 32、搜索图标前缀、可清除） */}
      <div className="flex items-center px-4 py-3 flex-shrink-0">
        <SearchInput
          placeholder={t("canvas.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          clearable
          onClear={() => setSearch("")}
          containerClassName="flex-1"
          containerStyle={{ height: 32 }}
        />
      </div>
      <div className="scrollbar-ui scrollbar-ui-compact flex-1 overflow-y-auto min-h-0" style={{ padding: "0 16px 12px", scrollbarGutter: "stable" }}>
        {tree.nodeCount === 0 ? (
          <Empty role="status" className="min-h-[120px] p-6 text-muted-foreground">
            <EmptyMedia variant="icon" />
            <EmptyDescription>{t("canvas.empty")}</EmptyDescription>
          </Empty>
        ) : !hasMatch ? (
          <Empty role="status" className="min-h-[120px] p-6 text-muted-foreground">
            <EmptyMedia variant="icon" />
            <EmptyDescription>{t("common.noData")}</EmptyDescription>
          </Empty>
        ) : (
          <>
            {/* 组：可折叠容器，成员嵌套在其下 */}
            {visible.groupNodes.map((group) => (
              <GroupItem
                key={group.id}
                group={group}
                members={visible.membersByGroup.get(group.id) ?? []}
                selected={selectedNodeIds.has(group.id)}
                collapsed={collapsedGroups.has(group.id)}
                onToggle={() => toggleGroup(group.id)}
                selectedNodeIds={selectedNodeIds}
              />
            ))}

            {/* 未分组节点：按类型分组 */}
            {visible.ungroupedGroups.map((group) => (
              <div key={group.type} className="mb-3">
                <div className="mb-1 px-2 text-xs text-muted-foreground">
                  {NODE_TYPE_I18N[group.type] ? t(NODE_TYPE_I18N[group.type]) : group.type}
                </div>
                {group.nodes.map((node) => (
                  <ElementItem
                    key={node.id}
                    node={node}
                    selected={selectedNodeIds.has(node.id)}
                  />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
      <SheetFooter
        className="flex shrink-0 flex-row items-center justify-end gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
      >
        <AppstoreOutlined />
        <span>{tree.nodeCount} {t("canvas.nodesCount")}</span>
      </SheetFooter>
    </div>
  );
}
/** 组条目：点击定位组，点击箭头折叠/展开，成员缩进渲染 */
function GroupItem({ group, members, selected, collapsed, onToggle, selectedNodeIds }: {
  group: AnyNode;
  members: AnyNode[];
  selected: boolean;
  collapsed: boolean;
  onToggle: () => void;
  selectedNodeIds: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const centerNode = useCenterNode();
  const rawLabel = (group.data as { label?: string })?.label;
  // 与节点标题一致：自定义名也要带成员数，否则用户一改名计数就不再更新
  const label = rawLabel
    ? t("node.groupNamedWithCount", { label: rawLabel, count: members.length })
    : t("node.groupWithCount", { count: members.length });

  return (
    <Collapsible open={!collapsed} onOpenChange={onToggle} className="mb-1">
      <div className="relative flex items-center gap-2 px-2">
        {/* 选中竖条：与画布节点 --ring 选中描边同色（约定同 ApiSettingsDrawer） */}
        {selected && (
          <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-ring" />
        )}
        {/* 折叠箭头槽位：与普通节点的空槽位同宽，保证图标垂直对齐 */}
        <span className="shrink-0 flex items-center justify-center" style={{ width: ROW_INDENT, height: 24 }}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={label}
            >
              {collapsed ? <RightOutlined /> : <DownOutlined />}
            </Button>
          </CollapsibleTrigger>
        </span>
        <Button
          type="button"
          variant="ghost"
          aria-label={label}
          aria-current={selected ? "true" : undefined}
          onClick={() => {
            const s = useCanvasStore.getState();
            s.setNodes(s.nodes.map((n) => ({ ...n, selected: n.id === group.id })));
            centerNode(s.nodes.find((n) => n.id === group.id) ?? group);
          }}
          className={`h-auto min-w-0 flex-1 justify-start gap-2 rounded-md py-1.5 text-left text-sm font-normal text-foreground${selected ? " bg-accent text-accent-foreground" : " hover:bg-muted dark:hover:bg-muted"}`}
        >
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded"
            style={{ background: `${getNodeTypeColor(NODE_TYPE.GROUP)}18` }}
          >
            {getNodeTypeIcon(NODE_TYPE.GROUP)}
          </div>
          <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
          <span className="shrink-0 rounded-full bg-popover px-1.5 text-[10px] text-muted-foreground">
            {members.length}
          </span>
        </Button>
      </div>
      <CollapsibleContent>
        {members.map((m) => (
          <ElementItem key={m.id} node={m} selected={selectedNodeIds.has(m.id)} depth={1} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

type ElementItemProps = { node: AnyNode; selected: boolean; depth?: number };

function ElementItemImpl(props: ElementItemProps) {
  const { node, selected, depth = 0 } = props;
  const { t } = useTranslation();
  const centerNode = useCenterNode();
  const nodeType = node.type || "";
  const typeLabel = nodeType && NODE_TYPE_I18N[nodeType] ? t(NODE_TYPE_I18N[nodeType]) : "";
  const rawLabel = (node.data as { label?: string })?.label;
  // 显式标注 string：nodeType 是字面量联合（全非空），不标注会让 TS 判定
  // 下方 `label || ...` 的右支永不可达，从而把 node 收窄成 never
  const label: string = rawLabel || typeLabel || nodeType;
  const src = node.type === NODE_TYPE.IMAGE ? (node.data as { src?: string }).src : undefined;
  const sourceUrl = (node.data as { src?: string }).src;
  const thumb = nodeType === NODE_TYPE.VIDEO && sourceUrl?.includes("/api/files/")
    ? `${sourceUrl}?w=64`
    : sourceUrl;
  const hasPreview = Boolean(
    (nodeType === NODE_TYPE.IMAGE && src) || (nodeType === NODE_TYPE.VIDEO && thumb),
  );

  // 状态点：生成/处理中转圈，失败（任务失败或上传失败）红点，其余不显示
  const { taskBinding, upload, createdAt, fileSize } = node.data as {
    taskBinding?: TaskBinding;
    upload?: UploadState;
    createdAt?: number;
    fileSize?: number;
  };
  const generating = isGenerating(taskBinding) || upload?.uploading === true;
  const failed = taskBinding?.status === "failed" || !!upload?.error;
  const plainText = nodeType === NODE_TYPE.TEXT ? (node.data as { plainText?: string }).plainText : undefined;

  // 第二行元数据：类型 · 尺寸/时长/字数 · 大小（与画布节点标题栏同口径）
  const metaParts: string[] = [];
  if (typeLabel) metaParts.push(typeLabel);
  switch (nodeType) {
    case NODE_TYPE.IMAGE:
    case NODE_TYPE.VIDEO: {
      const { naturalWidth: w, naturalHeight: h, duration } = node.data as { naturalWidth?: number; naturalHeight?: number; duration?: number };
      if (w && h && w > 0 && h > 0) metaParts.push(`${w}×${h}`);
      if (nodeType === NODE_TYPE.VIDEO && duration && duration > 0) metaParts.push(formatTime(duration));
      break;
    }
    case NODE_TYPE.AUDIO: {
      const { duration } = node.data as { duration?: number };
      if (duration && duration > 0) metaParts.push(formatTime(duration));
      break;
    }
    case NODE_TYPE.TEXT: {
      if (plainText && plainText.length > 0) metaParts.push(String(plainText.length));
      break;
    }
  }
  const sizeText = formatBytes(fileSize);
  if (sizeText) metaParts.push(sizeText);
  const metaLine = metaParts.length > 0 ? metaParts.join(" · ") : null;
  const timeText = formatDateTime(createdAt);

  const handleClick = useCallback(() => {
    // 与画布点选节点同一语义：单选该节点（列表选中态来自 nodes 的 selected 标记）并定位居中
    const s = useCanvasStore.getState();
    s.setNodes(s.nodes.map((n) => ({ ...n, selected: n.id === node.id })));
    centerNode(s.nodes.find((n) => n.id === node.id) ?? node);
  }, [node, centerNode]);

  return (
    <AssetHoverPreview
      asset={{
        name: label,
        mediaType: nodeType === NODE_TYPE.TEXT ? "text" : nodeType === NODE_TYPE.VIDEO ? "video" : "image",
        sourceUrl,
        plainText,
      }}
      enabled={Boolean(
        (sourceUrl && (nodeType === NODE_TYPE.IMAGE || nodeType === NODE_TYPE.VIDEO))
        || (plainText && nodeType === NODE_TYPE.TEXT),
      )}
    >
      <Button
      type="button"
      onClick={handleClick}
      aria-label={label || `Node ${node.id}`}
      aria-current={selected ? "true" : undefined}
      variant="ghost"
      className={`relative h-auto w-full justify-start gap-2 rounded-md py-1.5 text-left text-sm font-normal text-foreground${selected ? " bg-accent text-accent-foreground" : " hover:bg-muted dark:hover:bg-muted"}`}
      style={{
        paddingLeft: 8 + depth * ROW_INDENT,
        paddingRight: 8,
      }}
    >
      {/* 选中竖条：与画布节点 --ring 选中描边同色（约定同 ApiSettingsDrawer） */}
      {selected && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-ring" />
      )}
      {/* 空槽位：与组行折叠箭头同宽，保证图标与组图标垂直对齐 */}
      <span className="shrink-0" style={{ width: ROW_INDENT, height: 24 }} />
      {/* 缩略图/图标：等高正方形卡片（高度 = 标题 20 + 元数据 16 + 时间 16 三行） */}
      <div
        className={`relative flex h-[52px] w-[52px] shrink-0 items-center justify-center overflow-hidden rounded ${
          hasPreview ? "border border-border bg-popover" : ""
        }`}
        style={hasPreview ? undefined : { background: `${getNodeTypeColor(nodeType)}18` }}
      >
        {nodeType === NODE_TYPE.IMAGE && src ? (
          <img src={src + "?w=64"} alt={label} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLElement).style.display = "none"; }} />
        ) : nodeType === NODE_TYPE.VIDEO && thumb ? (
          <>
            <img src={thumb} alt={label} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLElement).style.display = "none"; }} />
            {/* 视频类型角标：复用全局视频图标，避免把类型识别和播放操作混为一谈 */}
            <span className="pointer-events-none absolute left-1 top-1 flex size-4 items-center justify-center rounded-sm border border-border/60 bg-background/85 text-foreground shadow-sm">
              <VideoCameraOutlined
                aria-hidden="true"
                className="size-2.5"
              />
            </span>
          </>
        ) : nodeType === NODE_TYPE.TEXT && plainText ? (
          /* 文本节点：内容预览小卡（与参考排版一致，正文片段替代类型图标） */
          <div className="h-full w-full overflow-hidden border border-border bg-popover px-1 py-0.5">
            <span className="break-all text-[8px] leading-[1.4] text-muted-foreground line-clamp-4">
              {plainText.slice(0, 64)}
            </span>
          </div>
        ) : (
          getNodeTypeIcon(nodeType)
        )}
      </div>
      {/* 固定三行高度：标题 20px + 元数据 16px + 时间 16px，缺行时整体仍保持同高 */}
      <div className={`flex-1 min-w-0 flex flex-col justify-center overflow-hidden${failed || generating ? " pr-5" : ""}`}>
        <div className="flex items-center gap-1.5 min-w-0 h-5">
          <span className="flex-1 truncate text-[13px] leading-5 font-medium">{label || `Node ${node.id}`}</span>
        </div>
        {metaLine && (
          <div className="truncate text-[11px] leading-4 text-muted-foreground">
            {metaLine}
          </div>
        )}
        {timeText && (
          <div className="flex items-center gap-1 text-[11px] leading-4 text-muted-foreground">
            <ClockCircleOutlined style={{ fontSize: 10 }} />
            <span className="tabular-nums">{timeText}</span>
          </div>
        )}
      </div>
      {(failed || generating) && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2">
          {failed ? (
            <Tooltip><TooltipTrigger asChild>
                <span
                  className="block size-1.5 rounded-full bg-destructive"
                />
              </TooltipTrigger><TooltipContent>{t("common.statusFailed")}</TooltipContent></Tooltip>
          ) : (
            <Tooltip><TooltipTrigger asChild>
                <LoadingOutlined className="block size-3 text-primary" spin />
              </TooltipTrigger><TooltipContent>{t("common.generating")}</TooltipContent></Tooltip>
          )}
        </span>
      )}
      </Button>
    </AssetHoverPreview>
  );
}

const ElementItem = memo(ElementItemImpl);

// ── 资产视图 ──
function AssetsView() {
  const { t } = useTranslation();
  const { message } = useAppFeedback();
  const folders = useAssetsStore((s) => s.folders);
  const getUncategorizedFolder = useAssetsStore((s) => s.getUncategorizedFolder);
  const uncategorizedFolder = getUncategorizedFolder("personal");

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<AssetType[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);

  // 抽屉只保留紧凑展示；查询、防抖、分页、错误重试完全交给资产模块。
  const {
    items,
    totalCount,
    loading,
    loadingMore,
    loadError,
    hasMore,
    loadMore,
    retry,
    reload,
    appliedSearch,
  } = useAssetLibrary({
    enabled: true,
    scope: "personal",
    folderId: activeFolderId,
    search,
    categories: typeFilter,
  });

  // 资产条目在视图外变更（画布收藏 / 取消收藏等）时失效重拉当前视图。
  // 用 ref 记录上次处理过的版本：挂载首帧与版本未变时不重复请求。
  const libraryVersion = useAssetsStore((s) => s.libraryVersion);
  const lastLibraryVersionRef = useRef(libraryVersion);
  useEffect(() => {
    if (libraryVersion === lastLibraryVersionRef.current) return;
    lastLibraryVersionRef.current = libraryVersion;
    reload();
  }, [libraryVersion, reload]);

  const handleInsertCanvas = useCallback((asset: AssetItem) => {
    const node = createAssetNode(asset, getViewportCenter(), findFreePosition);
    if (node) useCanvasStore.getState().addNodes([node]);
    message.success(t("asset.added"));
  }, [message, t]);

  // 完整祖先面包屑链（从根到当前文件夹）
  const breadcrumb = useMemo<AssetFolder[]>(() => {
    if (!activeFolderId) return [];
    const crumbs: AssetFolder[] = [];
    let cur: string | undefined = activeFolderId;
    while (cur) {
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      crumbs.unshift(f);
      cur = f.parentId || undefined;
    }
    return crumbs;
  }, [activeFolderId, folders]);

  // 与资产弹窗共用同一套递归计数逻辑，保证目录数量一致。
  const recursiveCounts = useMemo(
    () => computeRecursiveFolderCounts(folders),
    [folders],
  );

  const gridFolders = useMemo<AssetFolder[]>(() => {
    const childFolders = selectChildFolders(folders, "personal", activeFolderId ?? undefined).map((f) => ({
      ...f,
      count: recursiveCounts[f.id] ?? f.count ?? 0,
    }));
    if (activeFolderId !== null) return childFolders;
    return uncategorizedFolder ? [{ ...uncategorizedFolder, name: t("asset.uncategorized") }, ...childFolders] : childFolders;
  }, [activeFolderId, folders, uncategorizedFolder, recursiveCounts, t]);

  // 用生效搜索词（appliedSearch）而非原始输入：清空搜索时与资产列表同帧切换，避免两者短暂叠加。
  const showFolderGrid = typeFilter.length === 0 && !appliedSearch.trim();

  return (
    // canvas-asset-drawer：画布拖放链路的排除标记（InfiniteCanvas.shouldIgnoreFileDrop），
    // 使抽屉区域不作为画布落点——拖到抽屉上透传建节点 / 触发上传均被拦截
    <div className="canvas-asset-drawer flex flex-col h-full">
      {/* 搜索栏 + 风格筛选 */}
      <div className="flex shrink-0 items-center gap-2 px-4 py-3">
        <SearchInput
          placeholder={t("asset.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          clearable
          onClear={() => setSearch("")}
          containerClassName="h-8 flex-1"
        />
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-pressed={typeFilter.length > 0}
                  className={typeFilter.length > 0 ? "bg-muted text-foreground" : undefined}
                >
                  <FilterIcon />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("asset.filter")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="bottom" align="end" className="w-52">
            <DropdownMenuLabel>{t("asset.filter")}</DropdownMenuLabel>
            {ASSET_CATEGORIES.filter((category): category is typeof category & { key: AssetType } => category.key !== "all").map((st) => (
              <DropdownMenuCheckboxItem
                key={st.key}
                checked={typeFilter.includes(st.key)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) => {
                  setTypeFilter((prev) =>
                    checked ? [...prev, st.key] : prev.filter((k) => k !== st.key),
                  );
                }}
              >
                {t(st.labelKey)}
              </DropdownMenuCheckboxItem>
            ))}
            {typeFilter.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setTypeFilter([])}>
                  {t("asset.filterClear")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 面包屑：完整祖先层级，逐级可点击；根视图也显示「个人资产库」。
          统一使用 Breadcrumb 的 Chevron 分隔符，保持层级和主题样式一致。 */}
      <AssetBreadcrumb
        rootLabel={t("asset.spacePersonal")}
        folders={breadcrumb}
        activeFolderId={activeFolderId}
        onNavigate={(folderId) => {
          setSearch("");
          setTypeFilter([]);
          setActiveFolderId(folderId);
        }}
        getFolderLabel={(folder) => folder.kind === "uncategorized" ? t("asset.uncategorized") : folder.name}
        collapsedLabel={t("asset.showParentFolders")}
        className="shrink-0 px-4 pb-2 text-xs"
        itemClassName="whitespace-nowrap text-xs"
      />

      {/* 紧凑资产网格；查询、加载、空态和重试逻辑由 AssetGrid / 资产 Hook 统一处理。
          首页加载期间沿用旧列表占位会短暂撑高容器，临时隐藏滚动条避免其闪现。 */}
      <div
        className={`scrollbar-ui scrollbar-ui-compact min-h-0 flex-1 px-4 pb-3 ${loading ? "overflow-hidden" : "overflow-y-auto"}`}
        style={{ scrollbarGutter: "stable" }}
      >
        <AssetGrid
          assets={items}
          folders={showFolderGrid ? gridFolders : undefined}
          folderCounts={recursiveCounts}
          compact
          showHoverPreview
          showInsertButton
          draggable
          onInsertCanvas={handleInsertCanvas}
          onEnterFolder={(folder) => { setSearch(""); setTypeFilter([]); setActiveFolderId(folder.id); }}
          loading={loading}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          loadError={loadError}
          onRetry={retry}
        />
      </div>

      {/* 底部统计 */}
      <SheetFooter
        className="flex shrink-0 flex-row items-center justify-end gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
      >
        {activeFolderId === null && typeFilter.length === 0 && !search.trim() ? (
          <>
            <FolderOpenOutlined />
            <span>{gridFolders.length} {t("asset.foldersLabel")}</span>
          </>
        ) : (
          <>
            <FolderOpenOutlined />
            <span>{totalCount || items.length} {t("asset.count")}</span>
          </>
        )}
      </SheetFooter>
    </div>
  );
}

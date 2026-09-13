/**
 * 画布资源管理器（Explorer）。
 * 上半部为节点大纲：按类型分组列出画布节点，支持搜索、筛选与定位选中；
 * 下半部为资产快捷区：分页浏览资产文件夹与素材，支持悬浮预览并拖入画布成节点。
 * 以 antd Drawer 实现，不绑定具体方位，可在主题层调整为左 / 右 / 上下布局。
 */
"use client";

import {
  AppstoreOutlined,
  CaretRightOutlined,
  CloseOutlined,
  DownOutlined,
  FilterOutlined,
  FolderOpenOutlined,
  LoadingOutlined,
  RightOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { App, Button, Checkbox, Drawer, Empty, Input, Popover, Tooltip } from "antd";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AssetsIcon } from "@/components/ui/icons/canvas/AssetsIcon";
import { MenuDivider } from "@/components/ui/MenuPopover";
import { createAssetNode } from "@/features/assets/add-asset";
import AssetGrid from "@/features/assets/components/AssetGrid";
import { AssetHoverPreview, useAssetHoverPreview } from "@/features/assets/components/AssetHoverPreview";
import { useAssetLibrary } from "@/features/assets/hooks/use-asset-library";
import { computeRecursiveFolderCounts, useAssetsStore } from "@/features/assets/store";
import type { AssetFolder, AssetItem, AssetType } from "@/features/assets/types";
import { useVideoThumbnail } from "@/features/canvas/hooks/use-video-thumbnail";
import { getNodeTypeColor, getNodeTypeIcon, NODE_TYPE_I18N, NODE_TYPE_ORDER } from "@/features/canvas/NodeTypeDisplayMeta";
import { useCenterNode } from "@/features/canvas/shared/center-node";
import { findFreePosition, getViewportCenter, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";
import { ASSET_CATEGORIES, NODE_TYPE } from "@/lib/constants";

export const DRAWER_WIDTH = 360;

/** 元素树每层缩进宽度，同时用作组折叠箭头槽位宽度，保证各组/节点图标垂直对齐 */
const ROW_INDENT = 18;

interface CanvasExplorerProps {
  open: boolean;
  onClose: () => void;
}

export default function CanvasExplorer({ open, onClose }: CanvasExplorerProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<string>("elements");
  const isDark = useCanvasStore((s) => s.theme) === "dark";

  return (
    <Drawer
      className="canvas-sidebar"
      open={open}
      onClose={onClose}
      mask={false}
      placement="left"
      size={DRAWER_WIDTH}
      styles={{
        header: {
          background: "var(--canvas-bg)",
          borderBottom: "1px solid var(--canvas-border)",
          padding: "12px 16px",
        },
        body: {
          background: "var(--canvas-bg)",
          padding: 0,
        },
        section: isDark ? {
          borderRight: "1px solid #2c2c31",
        } : undefined,
      }}
      closable={false}
      title={
        // 原生 title 换成系统 Tooltip，样式与全站一致
        <Tooltip title={t("common.close")}>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded transition-colors hover:bg-white/10 cursor-pointer"
            style={{ color: "var(--canvas-text-dim)" }}
          >
            <CloseOutlined />
          </button>
        </Tooltip>
      }
    >
      <style>{`
        .canvas-sidebar .ant-drawer-body { display:flex; flex-direction:column; height:100%; overflow:hidden; }
        .canvas-sidebar .ant-input-affix-wrapper {
          background: var(--canvas-bg-elevated) !important;
          border-color: var(--canvas-border) !important;
          color: var(--canvas-text) !important;
          border-radius: 8px !important;
          height: 32px !important;
        }
        .canvas-sidebar .ant-input {
          background: transparent !important;
          color: var(--canvas-text) !important;
          font-size: 13px !important;
          height: 30px !important;
        }
        .canvas-sidebar .ant-input-affix-wrapper:hover,
        .canvas-sidebar .ant-input-affix-wrapper:focus,
        .canvas-sidebar .ant-input-affix-wrapper-focused {
          border-color: var(--canvas-border) !important;
          box-shadow: none !important;
        }
        .canvas-sidebar .ant-drawer-content-wrapper { border-right: 1px solid var(--canvas-border) !important; }
        .canvas-sidebar ::-webkit-scrollbar { width:4px; }
        .canvas-sidebar ::-webkit-scrollbar-track { background:transparent; }
        .canvas-sidebar ::-webkit-scrollbar-thumb { background:var(--canvas-border); border-radius:2px; }
      `}</style>

      <div className="canvas-sidebar flex flex-col h-full select-none">
        {/* Tab 切换器 */}
        <div className="flex items-center border-b flex-shrink-0" style={{ borderColor: "var(--canvas-border)" }}>
          <button
            className="flex-1 flex items-center justify-center gap-1.5 py-3 text-sm font-medium transition-colors border-b-2"
            style={{
              background: "transparent", cursor: "pointer",
              color: activeTab === "elements" ? "var(--canvas-text)" : "var(--canvas-text-dim)",
              borderColor: activeTab === "elements" ? "var(--canvas-text)" : "transparent",
            }}
            onClick={() => setActiveTab("elements")}
          >
            <AppstoreOutlined />
            {t("canvas.tab.elements")}
          </button>
          <button
            className="flex-1 flex items-center justify-center gap-1.5 py-3 text-sm font-medium transition-colors border-b-2"
            style={{
              background: "transparent", cursor: "pointer",
              color: activeTab === "assets" ? "var(--canvas-text)" : "var(--canvas-text-dim)",
              borderColor: activeTab === "assets" ? "var(--canvas-text)" : "transparent",
            }}
            onClick={() => setActiveTab("assets")}
          >
            <AssetsIcon />
            {t("canvas.tab.assets")}
          </button>
        </div>

        {/* Tab 内容：双挂载保留状态，切换 tab 不丢导航/不重复请求 */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <div className={activeTab === "elements" ? "h-full" : "hidden"}>
            <CanvasElementsView />
          </div>
          <div className={activeTab === "assets" ? "h-full" : "hidden"}>
            <AssetsView />
          </div>
        </div>
      </div>
    </Drawer>
  );
}
// ── 元素视图 ──

/** 按 NODE_TYPE_ORDER 对节点按类型分组（未分组节点使用） */
function groupNodesByType(nodes: AnyNode[]): { type: string; nodes: AnyNode[] }[] {
  const groups: { type: string; nodes: AnyNode[] }[] = [];
  const byType = new Map<string, AnyNode[]>();
  for (const n of nodes) {
    const list = byType.get(n.type || "");
    if (list) list.push(n);
    else byType.set(n.type || "", [n]);
  }
  for (const type of NODE_TYPE_ORDER) {
    const list = byType.get(type);
    if (list && list.length > 0) groups.push({ type, nodes: list.reverse() });
    byType.delete(type);
  }
  // Remaining types (uncategorized)
  for (const [type, list] of byType) {
    if (list.length > 0) groups.push({ type, nodes: list.reverse() });
  }
  return groups;
}

/** 组内成员按类型稳定排序（同类型聚合，不打散原相对顺序） */
function sortMembersByType(nodes: AnyNode[]): AnyNode[] {
  const order = new Map(NODE_TYPE_ORDER.map((type, i) => [type, i]));
  const rank = (n: AnyNode) => order.get(n.type || "") ?? NODE_TYPE_ORDER.length;
  return [...nodes].sort((a, b) => rank(a) - rank(b));
}

function CanvasElementsView() {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const selectedNodeIds = useMemo(
    () => new Set(nodes.filter((n) => n.selected).map((n) => n.id)),
    [nodes],
  );

  // 构建大纲树：组节点作为可折叠容器，成员嵌套在内；未分组节点按类型分组。
  const { groupNodes, membersByGroup, ungroupedGroups } = useMemo(() => {
    const groupNodes: AnyNode[] = [];
    const membersByGroup = new Map<string, AnyNode[]>();
    const ungrouped: AnyNode[] = [];
    const groupIds = new Set<string>();

    for (const n of nodes) {
      if (n.type === NODE_TYPE.GROUP) {
        groupNodes.push(n);
        groupIds.add(n.id);
      }
    }
    for (const n of nodes) {
      if (n.type === NODE_TYPE.GROUP) continue;
      const gid = (n.data as { groupId?: string })?.groupId;
      if (gid && groupIds.has(gid)) {
        const list = membersByGroup.get(gid);
        if (list) list.push(n);
        else membersByGroup.set(gid, [n]);
      } else {
        // 孤儿节点（groupId 指向不存在的组）按未分组兜底
        ungrouped.push(n);
      }
    }

    return {
      groupNodes,
      membersByGroup,
      ungroupedGroups: groupNodesByType(ungrouped),
    };
  }, [nodes]);

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
      <div className="flex-1 overflow-y-auto min-h-0" style={{ padding: "12px 16px", scrollbarGutter: "stable" }}>
        {nodes.length === 0 ? (
          <Empty description={<span style={{ color: "var(--canvas-text-dim)" }}>{t("canvas.empty")}</span>} />
        ) : (
          <>
            {/* 组：可折叠容器，成员嵌套在其下 */}
            {groupNodes.map((group) => (
              <GroupItem
                key={group.id}
                group={group}
                members={sortMembersByType(membersByGroup.get(group.id) ?? [])}
                selected={selectedNodeIds.has(group.id)}
                collapsed={collapsedGroups.has(group.id)}
                onToggle={() => toggleGroup(group.id)}
                selectedNodeIds={selectedNodeIds}
              />
            ))}

            {/* 未分组节点：按类型分组 */}
            {ungroupedGroups.map((group) => (
              <div key={group.type} className="mb-3">
                <div className="text-xs mb-1 px-2" style={{ color: "var(--canvas-text-muted)" }}>
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
      <div
        className="flex items-center justify-end gap-2 px-4 py-2.5 flex-shrink-0 text-xs border-t"
        style={{ borderColor: "var(--canvas-border)", color: "var(--canvas-text-muted)" }}
      >
        <AppstoreOutlined />
        <span>{nodes.length} {t("canvas.nodesCount")}</span>
      </div>
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
  selectedNodeIds: Set<string>;
}) {
  const { t } = useTranslation();
  const centerNode = useCenterNode();
  const rawLabel = (group.data as { label?: string })?.label;
  // 与节点标题一致：自定义名也要带成员数，否则用户一改名计数就不再更新
  const label = rawLabel
    ? t("node.groupNamedWithCount", { label: rawLabel, count: members.length })
    : t("node.groupWithCount", { count: members.length });

  return (
    <div className="mb-1">
      <div
        className="flex items-center gap-2 py-1.5 rounded-md cursor-pointer transition-colors text-sm select-none"
        style={{
          paddingLeft: 8,
          paddingRight: 8,
          background: selected ? "var(--canvas-bg-hover)" : "transparent",
          color: selected ? "var(--canvas-text)" : "var(--canvas-text-dim)",
        }}
        onClick={() => centerNode(group)}
      >
        {/* 折叠箭头槽位：与普通节点的空槽位同宽，保证图标垂直对齐 */}
        <span className="shrink-0 flex items-center justify-center" style={{ width: ROW_INDENT, height: 24 }}>
          <Tooltip title={collapsed ? t("common.expand") : t("common.collapse")}>
            <button
              className="w-4 h-4 flex items-center justify-center rounded hover:bg-white/10 cursor-pointer"
              style={{ color: "var(--canvas-text-muted)" }}
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
            >
              {collapsed ? <RightOutlined style={{ fontSize: 10 }} /> : <DownOutlined style={{ fontSize: 10 }} />}
            </button>
          </Tooltip>
        </span>
        <div
          className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0 overflow-hidden"
          style={{ background: `${getNodeTypeColor(NODE_TYPE.GROUP)}18` }}
        >
          {getNodeTypeIcon(NODE_TYPE.GROUP)}
        </div>
        <span className="flex-1 truncate text-[13px]">{label}</span>
        <span
          className="shrink-0 text-[10px] px-1.5 rounded-full"
          style={{ background: "var(--canvas-bg-elevated)", color: "var(--canvas-text-muted)" }}
        >
          {members.length}
        </span>
      </div>
      {!collapsed && members.map((m) => (
        <ElementItem key={m.id} node={m} selected={selectedNodeIds.has(m.id)} depth={1} />
      ))}
    </div>
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
  const { thumb, loading } = useVideoThumbnail(node.type === NODE_TYPE.VIDEO ? (node.data as { src?: string }).src : undefined);
  const preview = useAssetHoverPreview(DRAWER_WIDTH);
  const sourceUrl = (node.data as { src?: string }).src;

  const handleClick = useCallback(() => {
    centerNode(node);
  }, [node, centerNode]);

  return (
    <div
      onClick={handleClick}
      className="flex items-center gap-2 py-1.5 rounded-md cursor-pointer transition-colors text-sm select-none"
      style={{
        background: selected ? "var(--canvas-bg-hover)" : "transparent",
        color: selected ? "var(--canvas-text)" : "var(--canvas-text-dim)",
        paddingLeft: 8 + depth * ROW_INDENT,
        paddingRight: 8,
      }}
      onMouseEnter={(e) => {
        if (!selected) { (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-elevated)"; (e.currentTarget as HTMLElement).style.color = "var(--canvas-text)"; }
        if (sourceUrl) preview.onEnter(node as unknown as AssetItem, e);
      }}
      onMouseLeave={(e) => {
        if (!selected) { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--canvas-text-dim)"; }
        preview.onLeave();
      }}
    >
      {/* 空槽位：与组行折叠箭头同宽，保证图标与组图标垂直对齐 */}
      <span className="shrink-0" style={{ width: ROW_INDENT, height: 24 }} />
      {/* 缩略图/图标 */}
      <div
        className="relative w-8 h-8 rounded flex items-center justify-center flex-shrink-0 overflow-hidden"
        style={{
          minWidth: 32,
          background: (nodeType === NODE_TYPE.IMAGE && src) || (nodeType === NODE_TYPE.VIDEO && thumb)
            ? "var(--canvas-bg-elevated)"
            : `${getNodeTypeColor(nodeType)}18`,
          border: (nodeType === NODE_TYPE.IMAGE && src) || (nodeType === NODE_TYPE.VIDEO && thumb)
            ? "1px solid var(--canvas-border)"
            : undefined,
        }}
      >
        {nodeType === NODE_TYPE.IMAGE && src ? (
          <img src={src + "?w=64"} alt={label} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLElement).style.display = "none"; }} />
        ) : nodeType === NODE_TYPE.VIDEO && thumb ? (
          <>
            <img src={thumb} alt={label} className="w-full h-full object-cover" />
            {/* 视频播放角标：居中三角 + 投影，无圆底更轻，亮暗画面均清晰 */}
            <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <CaretRightOutlined
                style={{
                  fontSize: 14,
                  color: "rgba(255,255,255,0.96)",
                  filter: "drop-shadow(0 0 1px rgba(0,0,0,0.85)) drop-shadow(0 1px 2px rgba(0,0,0,0.6))",
                }}
              />
            </span>
          </>
        ) : nodeType === NODE_TYPE.VIDEO && loading ? (
          <LoadingOutlined style={{ fontSize: 14, color: "var(--canvas-text-dim)" }} />
        ) : (
          getNodeTypeIcon(nodeType)
        )}
      </div>
      <span className="flex-1 truncate text-[13px]">{label || `Node ${node.id}`}</span>
      <AssetHoverPreview asset={preview.asset} visible={preview.visible} x={preview.x} y={preview.y} />
    </div>
  );
}

const ElementItem = memo(ElementItemImpl);

// ── 资产视图 ──
function AssetsView() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { notification: notif } = App.useApp();
  const folders = useAssetsStore((s) => s.folders);
  const getChildFolders = useAssetsStore((s) => s.getChildFolders);
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
  } = useAssetLibrary({
    enabled: true,
    scope: "personal",
    folderId: activeFolderId,
    search,
    categories: typeFilter,
  });

  const handleInsertCanvas = useCallback((asset: AssetItem) => {
    const node = createAssetNode(asset, getViewportCenter(), findFreePosition);
    if (node) useCanvasStore.getState().addNodes([node]);
    notif.success({
      title: t("asset.added"),
      description: asset.name,
      placement: "bottomRight",
      duration: 3,
    });
  }, [notif, t]);

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
    const childFolders = getChildFolders("personal", activeFolderId ?? undefined).map((f) => ({
      ...f,
      count: recursiveCounts[f.id] ?? f.count ?? 0,
    }));
    if (activeFolderId !== null) return childFolders;
    return uncategorizedFolder ? [{ ...uncategorizedFolder, name: t("asset.uncategorized") }, ...childFolders] : childFolders;
  }, [getChildFolders, activeFolderId, uncategorizedFolder, recursiveCounts, t, lang]);

  const showFolderGrid = typeFilter.length === 0 && !search.trim();

  return (
    <div className="flex flex-col h-full">
      {/* 搜索栏 + 风格筛选 */}
      <div className="flex items-center gap-2 px-4 py-3 flex-shrink-0">
        <Input
          size="small"
          placeholder={t("asset.search")}
          prefix={<SearchOutlined style={{ color: "var(--canvas-text-dim)" }} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          style={{ height: 32 }}
          className="flex-1"
        />
        <Popover
          trigger="click"
          placement="bottomRight"
          styles={{ container: { padding: 0, background: "transparent" } }}
          content={
            <div className="menu-popover asset-filter-popover">
              <div style={{ padding: "2px 12px 4px", fontSize: 11, color: "var(--canvas-text-muted)" }}>{t("asset.filter")}</div>
              {ASSET_CATEGORIES.filter((category): category is typeof category & { key: AssetType } => category.key !== "all").map((st) => (
                <label key={st.key} className="filter-row">
                  <Checkbox
                    checked={typeFilter.includes(st.key)}
                    onChange={(e) => {
                      setTypeFilter((prev) =>
                        e.target.checked ? [...prev, st.key] : prev.filter((k) => k !== st.key),
                      );
                    }}
                  >
                    {t(st.labelKey)}
                  </Checkbox>
                </label>
              ))}
              {typeFilter.length > 0 && <MenuDivider />}
              {typeFilter.length > 0 && (
                <div className="filter-row" onClick={() => setTypeFilter([])} style={{ color: "var(--canvas-text-dim)", fontSize: 13 }}>
                  {t("asset.filterClear")}
                </div>
              )}
            </div>
          }
        >
          <Tooltip title={t("asset.filter")}>
            <Button
              size="small"
              type="text"
              icon={<FilterOutlined />}
              style={{
                height: 32,
                background: typeFilter.length > 0 ? "rgba(255,255,255,0.16)" : undefined,
              }}
              className="canvas-ctrl-btn"
            />
          </Tooltip>
        </Popover>
      </div>

      {/* 面包屑：完整祖先层级，逐级可点击（根视图也显示「个人资产库」） */}
      <div className="flex items-center gap-1 px-4 pb-2 flex-shrink-0 flex-wrap">
        {/* 根：个人资产库（根视图为当前项，进入文件夹后可点击返回，位置保持一致不加箭头） */}
        {activeFolderId === null ? (
          <span className="text-xs font-medium px-1 py-0.5 whitespace-nowrap" style={{ color: "var(--canvas-text)" }}>
            {t("asset.spacePersonal")}
          </span>
        ) : (
          <button
            onClick={() => { setTypeFilter([]); setActiveFolderId(null); }}
            className="text-xs px-1 py-0.5 rounded transition-colors hover:bg-white/5 whitespace-nowrap cursor-pointer"
            style={{ color: "var(--canvas-text-dim)" }}
          >
            {t("asset.spacePersonal")}
          </button>
        )}
        {breadcrumb.map((crumb) => {
          const isLast = crumb.id === activeFolderId;
          return (
            <span key={crumb.id} className="flex items-center gap-1">
              <span style={{ color: "var(--canvas-text-dim)" }}>/</span>
              {isLast ? (
                <span className="text-xs font-medium px-1 py-0.5 whitespace-nowrap" style={{ color: "var(--canvas-text)" }}>
                  {crumb.kind === "uncategorized" ? t("asset.uncategorized") : crumb.name}
                </span>
              ) : (
                <button
                  onClick={() => { setTypeFilter([]); setActiveFolderId(crumb.id); }}
                  className="text-xs px-1 py-0.5 rounded transition-colors hover:bg-white/5 whitespace-nowrap cursor-pointer"
                  style={{ color: "var(--canvas-text-dim)" }}
                >
                  {crumb.kind === "uncategorized" ? t("asset.uncategorized") : crumb.name}
                </button>
              )}
            </span>
          );
        })}
      </div>

      {/* 紧凑资产网格；查询、加载、空态和重试逻辑由 AssetGrid / 资产 Hook 统一处理 */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-3" style={{ scrollbarGutter: "stable" }}>
        <AssetGrid
          assets={items}
          folders={showFolderGrid ? gridFolders : undefined}
          folderCounts={recursiveCounts}
          compact
          showHoverPreview
          hoverPreviewAnchorX={DRAWER_WIDTH}
          onInsertCanvas={handleInsertCanvas}
          onEnterFolder={(folder) => setActiveFolderId(folder.id)}
          loading={loading}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          loadError={loadError}
          onRetry={retry}
        />
      </div>

      {/* 底部统计 */}
      <div
        className="flex items-center justify-end gap-2 px-4 py-2.5 flex-shrink-0 text-xs border-t"
        style={{ borderColor: "var(--canvas-border)", color: "var(--canvas-text-muted)" }}
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
      </div>
    </div>
  );
}


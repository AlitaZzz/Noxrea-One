"use client";

import {
  AppstoreOutlined,
  CloseOutlined,
  FilterOutlined,
  PartitionOutlined,
  FontSizeOutlined,
  GroupOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  LoadingOutlined,
  PictureOutlined,
  PlusOutlined,
  SearchOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { useReactFlow, type Node } from "@xyflow/react";
import { App, Button, Checkbox, Drawer, Empty, Input, Popover, Tooltip } from "antd";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AssetHoverPreview,useAssetHoverPreview } from "@/components/common/AssetHoverPreview";
import { MenuDivider } from "@/components/common/MenuPopover";
import { addAssetToCanvas } from "@/lib/add-asset";
import { assetApi } from "@/lib/api";
import type { AnyNode, AssetFolder, AssetItem, AssetType } from "@/lib/types";
import { NODE_TYPE, UNCATEGORIZED_FOLDER_ID } from "@/lib/types";
import { ASSET_PAGE_SIZE, computeRecursiveFolderCounts, fetchAssetPage, useAssetsStore } from "@/stores/assets-store";
import { useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";

// ── 节点类型顺序和标签映射 ──
const NODE_TYPE_I18N: Record<string, string> = {
  [NODE_TYPE.DIRECTOR]: "director.node",
  [NODE_TYPE.IMAGE]: "image.node",
  [NODE_TYPE.VIDEO]: "video.node",
  [NODE_TYPE.TEXT]: "text.node",
  [NODE_TYPE.GROUP]: "group.node",
};

const NODE_TYPE_ORDER = [
  NODE_TYPE.DIRECTOR,
  NODE_TYPE.IMAGE,
  NODE_TYPE.VIDEO,
  NODE_TYPE.TEXT,
  NODE_TYPE.GROUP,
];

// ── 资产风格筛选选项（替换原「新建文件夹」按钮）──
const ASSET_STYLE_TYPES: { key: AssetType; labelKey: string }[] = [
  { key: "character", labelKey: "asset.cat.character" },
  { key: "scene", labelKey: "asset.cat.scene" },
  { key: "object", labelKey: "asset.cat.object" },
  { key: "style", labelKey: "asset.cat.style" },
  { key: "audio", labelKey: "asset.cat.audio" },
  { key: "other", labelKey: "asset.cat.other" },
];

const TYPE_COLORS: Record<string, string> = {
  [NODE_TYPE.DIRECTOR]: "#ff8a3d",
  [NODE_TYPE.IMAGE]: "#52c41a",
  [NODE_TYPE.VIDEO]: "#13c2c2",
  [NODE_TYPE.TEXT]: "#1677ff",
  [NODE_TYPE.GROUP]: "#722ed1",
};

function getNodeTypeIcon(type: string) {
  const color = TYPE_COLORS[type] || "var(--canvas-text-dim)";
  const s = { fontSize: 18, color };
  switch (type) {
    case NODE_TYPE.TEXT:     return <FontSizeOutlined style={s} />;
    case NODE_TYPE.IMAGE:    return <PictureOutlined style={s} />;
    case NODE_TYPE.VIDEO:    return <VideoCameraOutlined style={s} />;
    case NODE_TYPE.DIRECTOR: return <PartitionOutlined style={s} />;
    case NODE_TYPE.GROUP:    return <GroupOutlined style={s} />;
    default:                 return <PictureOutlined style={s} />;
  }
}

// ── 视频缩略图提取 hook ──
// 模块级全局缓存：跨组件实例与 tab 切换复用，避免重复解码视频
const videoThumbCache = new Map<string, string>();

function useVideoThumbnail(src: string | undefined) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!src) return;
    const cached = videoThumbCache.get(src);
    if (cached) { setThumb(cached); return; }
    let cancelled = false;
    setLoading(true);
    setThumb(null);

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = src;

    const onSeek = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")!.drawImage(video, 0, 0);
        const url = canvas.toDataURL("image/jpeg", 0.6);
        videoThumbCache.set(src, url);
        setThumb(url);
      } catch { /* noop */ }
      setLoading(false);
      video.remove();
    };
    const onMeta = () => { video.currentTime = 1; };
    const onErr = () => { if (!cancelled) { setLoading(false); video.remove(); } };

    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("seeked", onSeek);
    video.addEventListener("error", onErr);

    return () => { cancelled = true; video.remove(); };
  }, [src]);
  return { thumb, loading };
}

export const DRAWER_WIDTH = 360;

interface CanvasSidebarProps {
  open: boolean;
  onClose: () => void;
}

export default function CanvasSidebar({ open, onClose }: CanvasSidebarProps) {
  const t = useI18nStore((s) => s.t);
  const lang = useI18nStore((s) => s.lang);
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
        <button
          onClick={onClose}
          className="flex items-center justify-center w-7 h-7 rounded transition-colors hover:bg-white/10 cursor-pointer"
          style={{ color: "var(--canvas-text-dim)" }}
          title={t("close")}
        >
          <CloseOutlined />
        </button>
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

      <div className="canvas-sidebar flex flex-col h-full">
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
            <FolderOpenOutlined />
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
function CanvasElementsView() {
  const t = useI18nStore((s) => s.t);
  const nodes = useCanvasStore((s) => s.nodes);

  const selectedNodeIds = useMemo(
    () => new Set(nodes.filter((n) => n.selected).map((n) => n.id)),
    [nodes],
  );

  // Group nodes by type in defined order
  const grouped = useMemo(() => {
    const groups: { type: string; nodes: AnyNode[] }[] = [];
    const byType = new Map<string, AnyNode[]>();
    for (const n of nodes) {
      const list = byType.get(n.type || "");
      if (list) list.push(n as AnyNode);
      else byType.set(n.type || "", [n as AnyNode]);
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
  }, [nodes]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto min-h-0" style={{ padding: "12px 16px", scrollbarGutter: "stable" }}>
        {grouped.length === 0 ? (
          <Empty description={<span style={{ color: "var(--canvas-text-dim)" }}>{t("canvas.empty")}</span>} />
        ) : (
          grouped.map((group) => (
            <div key={group.type} className="mb-3">
              <div className="text-xs mb-1 px-2" style={{ color: "var(--canvas-text-muted)" }}>
                {NODE_TYPE_I18N[group.type] ? t(NODE_TYPE_I18N[group.type]) : group.type}
              </div>
              {group.nodes.map((node) => (
                <ElementItem
                  key={node.id}
                  node={node as AnyNode}
                  selected={selectedNodeIds.has(node.id)}
                />
              ))}
            </div>
          ))
        )}
      </div>
      <div
        className="flex items-center justify-end gap-2 px-4 py-2.5 flex-shrink-0 text-xs border-t"
        style={{ borderColor: "var(--canvas-border)", color: "var(--canvas-text-muted)" }}
      >
        <AppstoreOutlined />
        <span>{nodes.length} {t("nodes.count")}</span>
      </div>
    </div>
  );
}

type ElementItemProps = { node: Node; selected: boolean };

function ElementItemImpl(props: ElementItemProps) {
  const { node, selected } = props;
  const t = useI18nStore((s) => s.t);
  const { setCenter } = useReactFlow();
  const nodeType = node.type || "";
  const typeLabel = nodeType && NODE_TYPE_I18N[nodeType] ? t(NODE_TYPE_I18N[nodeType]) : "";
  const rawLabel = (node.data as { label?: string })?.label;
  const label = rawLabel || typeLabel || nodeType;
  const src = node.type === NODE_TYPE.IMAGE ? (node.data as { src?: string }).src : undefined;
  const { thumb, loading } = useVideoThumbnail(node.type === NODE_TYPE.VIDEO ? (node.data as { src?: string }).src : undefined);
  const preview = useAssetHoverPreview(DRAWER_WIDTH);
  const sourceUrl = (node.data as { src?: string }).src;

  const handleClick = useCallback(() => {
    const x = node.position.x + ((node.width as number) ?? 200) / 2;
    const y = node.position.y + ((node.height as number) ?? 200) / 2;
    setCenter(x, y, { zoom: 1.0, duration: 300 });
  }, [node, setCenter]);

  return (
    <div
      onClick={handleClick}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors text-sm select-none"
      style={{
        background: selected ? "var(--canvas-bg-hover)" : "transparent",
        color: selected ? "var(--canvas-text)" : "var(--canvas-text-dim)",
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
      {/* 缩略图/图标 */}
      <div
        className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0 overflow-hidden"
        style={{
          minWidth: 32,
          background: (nodeType === NODE_TYPE.IMAGE && src) || (nodeType === NODE_TYPE.VIDEO && thumb)
            ? "var(--canvas-bg-elevated)"
            : `${TYPE_COLORS[nodeType] || "var(--canvas-text-dim)"}18`,
        }}
      >
        {nodeType === NODE_TYPE.IMAGE && src ? (
          <img src={src + "?w=64"} alt={label} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLElement).style.display = "none"; }} />
        ) : nodeType === NODE_TYPE.VIDEO && thumb ? (
          <img src={thumb} alt={label} className="w-full h-full object-cover" />
        ) : nodeType === NODE_TYPE.VIDEO && loading ? (
          <LoadingOutlined style={{ fontSize: 14, color: "var(--canvas-text-dim)" }} />
        ) : (
          getNodeTypeIcon(nodeType)
        )}
      </div>
      <span className="flex-1 truncate text-xs">{label || `Node ${node.id}`}</span>
      <AssetHoverPreview asset={preview.asset} visible={preview.visible} x={preview.x} y={preview.y} />
    </div>
  );
}

const ElementItem = memo(ElementItemImpl);

// ── 资产视图 ──
function AssetsView() {
  const t = useI18nStore((s) => s.t);
  const lang = useI18nStore((s) => s.lang);
  const { notification: notif } = App.useApp();
  const folders = useAssetsStore((s) => s.folders);
  const getChildFolders = useAssetsStore((s) => s.getChildFolders);

  // Independent local state — not shared with AssetsModal
  const [items, setItems] = useState<AssetItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [uncategorizedCount, setUncategorizedCount] = useState(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const versionRef = useRef(0);

  const fetchAndReplace = useCallback(async (filters: { search: string; folderId: string | null | undefined; category?: string[] }) => {
    const v = ++versionRef.current;
    setItems([]);
    setTotalCount(0);
    setLoading(true);
    try {
      const result = await fetchAssetPage(
        { category: filters.category && filters.category.length ? filters.category : "all", search: filters.search, folderId: filters.folderId, spaceKey: "personal" },
        0,
      );
      if (v !== versionRef.current) return;
      setItems(result.items);
      setTotalCount(result.total);
    } catch { /* ignore */ }
    if (v === versionRef.current) setLoading(false);
  }, []);

  const fetchNextPage = useCallback(async () => {
    // 根视图无搜索且不筛选时不展示散落资产
    if (activeFolderId === null && !search.trim() && typeFilter.length === 0) return;
    const v = ++versionRef.current;
    setLoadingMore(true);
    try {
      const folderId = typeFilter.length > 0
        ? undefined
        : (activeFolderId === null ? undefined : (activeFolderId === UNCATEGORIZED_FOLDER_ID ? null : activeFolderId));
      const result = await fetchAssetPage(
        { category: typeFilter.length ? typeFilter : "all", search, folderId, spaceKey: "personal" },
        items.length,
      );
      if (v !== versionRef.current) return;
      setItems((prev) => [...prev, ...result.items]);
      setTotalCount(result.total);
    } catch { /* ignore */ }
    if (v === versionRef.current) setLoadingMore(false);
  }, [search, activeFolderId, typeFilter, items.length]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (typeFilter.length > 0) {
        // 风格筛选：跨全部个人资产按类型筛选（忽略文件夹层级）
        fetchAndReplace({ search, folderId: undefined, category: typeFilter });
        return;
      }
      if (activeFolderId === null) {
        if (!search.trim()) {
          // 根视图无搜索：仅展示文件夹（含虚拟「未分类」）
          setItems([]);
          setTotalCount(0);
          setLoading(false);
          return;
        }
        // 根视图 + 搜索：跨文件夹全局搜索（folderId 为空）
        fetchAndReplace({ search, folderId: undefined });
        return;
      }
      const folderId = activeFolderId === UNCATEGORIZED_FOLDER_ID ? null : activeFolderId;
      fetchAndReplace({ search, folderId });
    }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search, activeFolderId, typeFilter, fetchAndReplace]);

  // 拉取「未分类」资产数量（仅根视图需要）
  useEffect(() => {
    if (activeFolderId !== null) { setUncategorizedCount(0); return; }
    let cancelled = false;
    assetApi.listAssets({ space_key: "personal", folder_id: -1, skip: 0, limit: 1 })
      .then((r) => { if (!cancelled) setUncategorizedCount(r.data?.total ?? 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeFolderId]);

  const hasMore = items.length < totalCount;

  // 用 ref 持有最新 fetchNextPage，避免 items 增长时反复重建 observer
  const fetchNextPageRef = useRef(fetchNextPage);
  useEffect(() => { fetchNextPageRef.current = fetchNextPage; });

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loadingMore) return;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) fetchNextPageRef.current(); },
      { root: el.parentElement, rootMargin: "100px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore]);

  const handleInsertCanvas = useCallback((asset: AssetItem) => {
    addAssetToCanvas(asset);
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
    if (activeFolderId === UNCATEGORIZED_FOLDER_ID) {
      return [{ id: UNCATEGORIZED_FOLDER_ID, name: t("asset.uncategorized"), spaceKey: "personal", parentId: undefined, createdAt: 0, count: 0 }];
    }
    const crumbs: AssetFolder[] = [];
    let cur: string | undefined = activeFolderId;
    while (cur) {
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      crumbs.unshift(f);
      cur = f.parentId || undefined;
    }
    return crumbs;
  }, [activeFolderId, folders, t, lang]);

  // 文件夹递归计数（含所有子孙子文件夹），仅取 personal 空间
  const recursiveCounts = useMemo(
    () => computeRecursiveFolderCounts(folders.filter((f) => f.spaceKey === "personal")),
    [folders],
  );

  const gridFolders = useMemo<AssetFolder[]>(() => {
    const childFolders = getChildFolders("personal", activeFolderId ?? undefined).map((f) => ({
      ...f,
      count: recursiveCounts[f.id] ?? f.count ?? 0,
    }));
    if (activeFolderId !== null) return childFolders;
    return [
      ...childFolders,
      { id: UNCATEGORIZED_FOLDER_ID, name: t("asset.uncategorized"), spaceKey: "personal", parentId: undefined, createdAt: 0, count: uncategorizedCount },
    ];
  }, [getChildFolders, activeFolderId, uncategorizedCount, recursiveCounts, t, lang]);

  const showFolderGrid = typeFilter.length === 0 && !search.trim();
  const hasContent = items.length > 0 || (showFolderGrid ? gridFolders.length : 0) > 0;

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
              {ASSET_STYLE_TYPES.map((st) => (
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
                  {t("asset.filter.clear")}
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
            {t("asset.space.personal")}
          </span>
        ) : (
          <button
            onClick={() => { setTypeFilter([]); setActiveFolderId(null); }}
            className="text-xs px-1 py-0.5 rounded transition-colors hover:bg-white/5 whitespace-nowrap cursor-pointer"
            style={{ color: "var(--canvas-text-dim)" }}
          >
            {t("asset.space.personal")}
          </button>
        )}
        {breadcrumb.map((crumb) => {
          const isLast = crumb.id === activeFolderId;
          return (
            <span key={crumb.id} className="flex items-center gap-1">
              <span style={{ color: "var(--canvas-text-dim)" }}>/</span>
              {isLast ? (
                <span className="text-xs font-medium px-1 py-0.5 whitespace-nowrap" style={{ color: "var(--canvas-text)" }}>
                  {crumb.name}
                </span>
              ) : (
                <button
                  onClick={() => { setTypeFilter([]); setActiveFolderId(crumb.id); }}
                  className="text-xs px-1 py-0.5 rounded transition-colors hover:bg-white/5 whitespace-nowrap cursor-pointer"
                  style={{ color: "var(--canvas-text-dim)" }}
                >
                  {crumb.name}
                </button>
              )}
            </span>
          );
        })}
      </div>

      {/* 资产网格 */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-3" style={{ scrollbarGutter: "stable" }}>
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[200px]">
            <LoadingOutlined style={{ fontSize: 18, color: "var(--canvas-text-dim)" }} />
          </div>
        ) : !hasContent ? (
          <div className="flex items-center justify-center h-full min-h-[200px]">
            <Empty description={<span style={{ color: "var(--canvas-text-dim)" }}>{t("asset.empty")}</span>} />
          </div>
        ) : (
          <>
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
              {showFolderGrid && gridFolders.map((folder) => (
                <div
                  key={folder.id}
                  onClick={() => { setTypeFilter([]); setActiveFolderId(folder.id); }}
                  className="relative group rounded-lg overflow-hidden border border-white/10 hover:border-white/30 transition-all cursor-pointer flex flex-col items-center justify-center gap-1"
                  style={{ background: "var(--canvas-bg-elevated)", aspectRatio: "1" }}
                >
                  <FolderOutlined style={{ fontSize: 28, color: "rgba(255,255,255,0.2)" }} />
                  <span className="text-white/60 text-[11px] px-1 text-center truncate w-full">{folder.name}</span>
                  {folder.count > 0 && (
                    <span className="absolute top-1.5 right-2 text-[10px] px-1 rounded bg-white/10" style={{ color: "rgba(255,255,255,0.6)" }}>{folder.count}</span>
                  )}
                </div>
              ))}
              {items.map((asset) => (
                <AssetThumbCard key={asset.id} asset={asset} onInsert={() => handleInsertCanvas(asset)} />
              ))}
            </div>
            <div ref={sentinelRef} className="flex items-center justify-center py-3">
              {loadingMore && <LoadingOutlined style={{ color: "var(--canvas-text-dim)" }} />}
            </div>
          </>
        )}
      </div>

      {/* 底部统计 */}
      <div
        className="flex items-center justify-end gap-2 px-4 py-2.5 flex-shrink-0 text-xs border-t"
        style={{ borderColor: "var(--canvas-border)", color: "var(--canvas-text-muted)" }}
      >
        {activeFolderId === null && typeFilter.length === 0 ? (
          <>
            <FolderOpenOutlined />
            <span>{gridFolders.length} {t("folders.label")}</span>
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

// ── 资产缩略图卡片 ──
function AssetThumbCard({ asset, onInsert }: { asset: AssetItem; onInsert: () => void }) {
  const t = useI18nStore((s) => s.t);
  const preview = useAssetHoverPreview(DRAWER_WIDTH);
  const sourceUrl = asset.metadata?.sourceUrl as string | undefined;
  const coverUrl = asset.metadata?.coverUrl as string | undefined;
  const isVideo = sourceUrl && /\.(mp4|webm|mov|avi|mkv)(\?.*)?$/i.test(sourceUrl);
  const imgSrc = isVideo ? coverUrl || sourceUrl : sourceUrl || "";
  const [imgError, setImgError] = useState(false);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onInsert(); } },
    [onInsert],
  );

  return (
    <div className="flex flex-col gap-1">
      <div
        tabIndex={0}
        role="button"
        aria-label={t("asset.insert") + " " + asset.name}
        onKeyDown={handleKeyDown}
        onMouseEnter={(e) => { if (sourceUrl) preview.onEnter(asset, e); }}
        onMouseLeave={preview.onLeave}
        className="group relative rounded-lg overflow-hidden border border-white/10 hover:border-white/40 transition-all"
        style={{ background: "var(--canvas-bg-elevated)", aspectRatio: "1" }}
      >
        {/* Hover overlay — send to canvas */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100 rounded-lg z-10">
          <button
            className="w-8 h-8 flex items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/40 transition-colors cursor-pointer"
            onClick={(e) => { e.stopPropagation(); onInsert(); }}
          >
            <PlusOutlined style={{ fontSize: 14 }} />
          </button>
        </div>
        {imgSrc && !imgError ? (
          <img src={imgSrc + "?w=160"} alt={asset.name} className="w-full h-full object-cover" loading="lazy" onError={() => setImgError(true)} />
        ) : (
          <div className="flex items-center justify-center h-full text-white/15 text-2xl font-bold">
            {isVideo ? "VID" : "IMG"}
          </div>
        )}
        {isVideo && !imgError && (
          <div className="absolute top-1 left-1 flex items-center justify-center w-5 h-5 rounded bg-black/50">
            <VideoCameraOutlined style={{ fontSize: 10, color: "rgba(255,255,255,0.8)" }} />
          </div>
        )}
      </div>
      <span className="text-[10px] leading-tight text-white/50 truncate px-0.5">{asset.name}</span>
      <AssetHoverPreview asset={preview.asset} visible={preview.visible} x={preview.x} y={preview.y} />
    </div>
  );
}

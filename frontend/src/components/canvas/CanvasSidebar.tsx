"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Input, Drawer, Empty, Tooltip } from "antd";
import {
  SearchOutlined,
  FontSizeOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  GroupOutlined,
  CameraOutlined,
  InboxOutlined,
  LoadingOutlined,
  AppstoreOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { useReactFlow } from "@xyflow/react";
import { useCanvasStore, markDirtyImmediate } from "@/stores/canvas-store";
import { useAssetsStore } from "@/stores/assets-store";
import { useI18nStore } from "@/stores/i18n-store";
import { useAssetHoverPreview, AssetHoverPreview } from "@/components/common/AssetHoverPreview";
import { NODE_TYPE } from "@/lib/types";
import { addAssetToCanvas } from "@/lib/add-asset";
import type { AssetItem } from "@/lib/types";

// ── 节点类型定义 ──
const NODE_TYPE_ORDER = [
  NODE_TYPE.DIRECTOR,
  NODE_TYPE.IMAGE,
  NODE_TYPE.VIDEO,
  NODE_TYPE.TEXT,
  NODE_TYPE.GROUP,
] as const;

const NODE_TYPE_LABELS: Record<string, { zh: string; en: string }> = {
  [NODE_TYPE.DIRECTOR]: { zh: "导演台", en: "Director" },
  [NODE_TYPE.IMAGE]: { zh: "图片", en: "Image" },
  [NODE_TYPE.VIDEO]: { zh: "视频", en: "Video" },
  [NODE_TYPE.TEXT]: { zh: "文本", en: "Text" },
  [NODE_TYPE.GROUP]: { zh: "编组", en: "Group" },
};

function getNodeTypeIcon(type: string) {
  switch (type) {
    case NODE_TYPE.TEXT:
      return <FontSizeOutlined style={{ color: "#1677ff" }} />;
    case NODE_TYPE.IMAGE:
      return <PictureOutlined style={{ color: "#52c41a" }} />;
    case NODE_TYPE.VIDEO:
      return <VideoCameraOutlined style={{ color: "#13c2c2" }} />;
    case NODE_TYPE.DIRECTOR:
      return <CameraOutlined style={{ color: "#ff8a3d" }} />;
    case NODE_TYPE.GROUP:
      return <GroupOutlined style={{ color: "#722ed1" }} />;
    default:
      return <PictureOutlined style={{ color: "var(--canvas-text-dim)" }} />;
  }
}

// ── 视频缩略图提取 hook ──
function useVideoThumbnail(src: string | undefined) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cache = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!src) return;
    const cached = cache.current.get(src);
    if (cached) {
      setThumb(cached);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setThumb(null);

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    const cleanup = () => {
      video.remove();
    };

    const extractFrame = () => {
      if (cancelled) { cleanup(); return; }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 80;
        canvas.height = 60;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          cache.current.set(src, dataUrl);
          if (!cancelled) {
            setThumb(dataUrl);
            setLoading(false);
          }
        }
      } catch {
        if (!cancelled) { setLoading(false); }
      }
      cleanup();
    };

    video.addEventListener("loadeddata", () => {
      video.currentTime = 0.1;
    });
    video.addEventListener("seeked", extractFrame, { once: true });
    video.addEventListener("error", () => {
      if (!cancelled) { setLoading(false); cleanup(); }
    });

    video.src = src;

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [src]);

  return { thumb, loading };
}

// ── 画布元素视图 ──
function CanvasElementsView() {
  const t = useI18nStore((s) => s.t);
  const lang = useI18nStore((s) => s.lang);
  const nodes = useCanvasStore((s) => s.nodes);
  const { setNodes, fitView } = useReactFlow();
  const [search, setSearch] = useState("");

  // 按类型分组并搜索过滤
  const grouped = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    const filtered = searchLower
      ? nodes.filter((n: any) => {
          const label = String(n.data?.label || "");
          return label.toLowerCase().includes(searchLower);
        })
      : nodes;

    const groups = NODE_TYPE_ORDER.map((type) => {
      const items = filtered.filter((n: any) => n.type === type);
      return { type, items };
    }).filter((g) => g.items.length > 0);

    return { groups, total: filtered.length };
  }, [nodes, search]);

  const handleClickNode = useCallback(
    (nodeId: string) => {
      const allNodes = useCanvasStore.getState().nodes;
      setNodes(
        allNodes.map((n: any) => ({
          ...n,
          selected: n.id === nodeId,
        }))
      );
      // Center viewport on the node
      const target = allNodes.find((n: any) => n.id === nodeId);
      if (target) {
        fitView({
          nodes: [{ id: nodeId }],
          duration: 300,
          maxZoom: 1.5,
        });
      }
      markDirtyImmediate();
    },
    [setNodes, fitView]
  );

  return (
    <div className="flex flex-col h-full">
      {/* 搜索栏 */}
      <div className="flex items-center gap-2 px-4 py-3 flex-shrink-0">
        <Input
          size="small"
          placeholder={t("canvas.search.placeholder")}
          prefix={<SearchOutlined style={{ color: "var(--canvas-text-dim)" }} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          style={{
            background: "var(--canvas-bg-elevated)",
            borderColor: "var(--canvas-border)",
            color: "var(--canvas-text)",
            borderRadius: 8,
            height: 32,
          }}
        />
      </div>

      {/* 节点列表 */}
      <div className="flex-1 overflow-y-auto min-h-0 px-3">
        {grouped.total === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[200px]">
            <Empty
              description={
                <span style={{ color: "var(--canvas-text-dim)" }}>
                  {search ? t("canvas.empty") : t("canvas.empty")}
                </span>
              }
            />
          </div>
        ) : (
          grouped.groups.map((group) => (
            <div key={group.type} className="mb-3">
              <div
                className="text-xs font-medium px-2 py-1.5 sticky top-0 z-10 rounded"
                style={{
                  color: "var(--canvas-text-dim)",
                  background: "var(--canvas-bg)",
                }}
              >
                {lang === "zh"
                  ? NODE_TYPE_LABELS[group.type]?.zh || group.type
                  : NODE_TYPE_LABELS[group.type]?.en || group.type}
                <span className="ml-1.5 opacity-50">({group.items.length})</span>
              </div>
              {group.items.map((node: any) => (
                <NodeListItem
                  key={node.id}
                  node={node}
                  onClick={() => handleClickNode(node.id)}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {/* 底部统计 */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 flex-shrink-0 text-xs border-t"
        style={{
          borderColor: "var(--canvas-border)",
          color: "var(--canvas-text-muted)",
        }}
      >
        <span>{t("canvas.total").replace("{n}", String(grouped.total))}</span>
      </div>
    </div>
  );
}

// ── 节点列表项 ──
function NodeListItem({ node, onClick }: { node: any; onClick: () => void }) {
  const label = String(node.data?.label || node.type || "");
  const nodeType = node.type as string;
  const { thumb, loading } = useVideoThumbnail(
    nodeType === NODE_TYPE.VIDEO ? node.data?.src : undefined
  );

  return (
    <div
      className="flex items-center gap-2.5 px-2 py-2 rounded-md cursor-pointer transition-colors text-sm"
      style={{ color: "var(--canvas-text)" }}
      onClick={onClick}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      {/* 图标/缩略图 */}
      <div
        className="flex-shrink-0 flex items-center justify-center rounded overflow-hidden"
        style={{ width: 32, height: 32, background: "var(--canvas-bg-elevated)" }}
      >
        {nodeType === NODE_TYPE.IMAGE && node.data?.src ? (
          <img
            src={node.data.src}
            alt={label}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onError={(e) => {
              (e.target as HTMLElement).style.display = "none";
            }}
          />
        ) : nodeType === NODE_TYPE.VIDEO && thumb ? (
          <img src={thumb} alt={label} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : nodeType === NODE_TYPE.VIDEO && loading ? (
          <LoadingOutlined style={{ fontSize: 14, color: "var(--canvas-text-dim)" }} />
        ) : (
          <span className="flex items-center justify-center" style={{ fontSize: 16 }}>
            {getNodeTypeIcon(nodeType)}
          </span>
        )}
      </div>
      {/* 标签 */}
      <span className="flex-1 truncate">{label || `Node ${node.id}`}</span>
    </div>
  );
}

// ── 资产视图 ──
function AssetsView() {
  const t = useI18nStore((s) => s.t);
  const items = useAssetsStore((s) => s.items);
  const getFiltered = useAssetsStore((s) => s.getFiltered);
  const [search, setSearch] = useState("");

  const filtered = useMemo(
    () => getFiltered("all", search, null, "personal"),
    [items, search, getFiltered]
  );

  const handleInsertCanvas = useCallback(
    (asset: AssetItem) => {
      addAssetToCanvas(asset);
    },
    []
  );

  return (
    <div className="flex flex-col h-full">
      {/* 搜索栏 */}
      <div className="flex items-center gap-2 px-4 py-3 flex-shrink-0">
        <Input
          size="small"
          placeholder={t("asset.search")}
          prefix={<SearchOutlined style={{ color: "var(--canvas-text-dim)" }} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          style={{
            background: "var(--canvas-bg-elevated)",
            borderColor: "var(--canvas-border)",
            color: "var(--canvas-text)",
            borderRadius: 8,
            height: 32,
          }}
        />
      </div>

      {/* 资产网格 */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-3">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[200px]">
            <Empty
              description={
                <span style={{ color: "var(--canvas-text-dim)" }}>{t("asset.empty")}</span>
              }
            />
          </div>
        ) : (
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}
          >
            {filtered.map((asset) => (
              <AssetThumbCard
                key={asset.id}
                asset={asset}
                onInsert={() => handleInsertCanvas(asset)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部统计 */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 flex-shrink-0 text-xs border-t"
        style={{
          borderColor: "var(--canvas-border)",
          color: "var(--canvas-text-muted)",
        }}
      >
        <InboxOutlined />
        <span>{filtered.length} {t("asset.count")}</span>
      </div>
    </div>
  );
}

// ── 资产缩略图卡片（适配 Drawer 窄容器） ──
export const DRAWER_WIDTH = 300;
function AssetThumbCard({ asset, onInsert }: { asset: AssetItem; onInsert: () => void }) {
  const t = useI18nStore((s) => s.t);
  const preview = useAssetHoverPreview(DRAWER_WIDTH);
  const sourceUrl = asset.metadata?.sourceUrl as string | undefined;
  const coverUrl = asset.metadata?.coverUrl as string | undefined;
  const isVideo = !!sourceUrl?.match(/\.(mp4|webm|mov)$/i);

  const handleInsert = () => onInsert();

  return (
    <div
      className="group relative rounded-lg border border-white/10 cursor-pointer overflow-hidden transition-all hover:border-white/30"
      style={{ background: "var(--canvas-bg-elevated)", aspectRatio: "1" }}
      onMouseEnter={(e) => preview.onEnter(asset, e)}
      onMouseLeave={() => preview.onLeave()}
      onClick={onInsert}
    >
      {/* 缩略图 */}
      {isVideo && coverUrl ? (
        <img
          src={coverUrl.includes("/api/files/") ? `${coverUrl}?w=120` : coverUrl}
          alt={asset.name}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : sourceUrl ? (
        <img
          src={sourceUrl.includes("/api/files/") ? `${sourceUrl}?w=120` : sourceUrl}
          alt={asset.name}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-white/15 text-3xl">
          {isVideo ? <VideoCameraOutlined /> : <PictureOutlined />}
        </div>
      )}
      {/* Hover overlay — send to canvas */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 rounded-lg">
        <Tooltip title={t("asset.send")}>
          <button
            className="w-9 h-9 flex items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/40 transition-colors"
            onClick={(e) => { e.stopPropagation(); handleInsert(); }}
          >
            <PlusOutlined />
          </button>
        </Tooltip>
      </div>
      {/* Name */}
      <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1 bg-gradient-to-t from-black/70 to-transparent">
        <div className="text-white/80 text-[11px] truncate">{asset.name}</div>
      </div>

      {/* Hover large preview */}
      <AssetHoverPreview asset={preview.asset} visible={preview.visible} x={preview.x} y={preview.y} />
    </div>
  );
}

// ── 主组件 ──
interface CanvasSidebarProps {
  open: boolean;
  onClose: () => void;
}

type TabKey = "elements" | "assets";

export default function CanvasSidebar({ open, onClose }: CanvasSidebarProps) {
  const t = useI18nStore((s) => s.t);
  const [activeTab, setActiveTab] = useState<TabKey>("elements");

  return (
    <Drawer
      title={null}
      open={open}
      onClose={onClose}
      placement="left"
      size={DRAWER_WIDTH}
      mask={false}
      destroyOnClose
      closeIcon={
        <span style={{ color: "var(--canvas-text-dim)", fontSize: 16 }}>✕</span>
      }
      styles={{
        header: {
          background: "var(--canvas-bg)",
          borderBottom: "1px solid var(--canvas-border)",
          padding: "8px 16px",
        },
        body: {
          background: "var(--canvas-bg)",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          height: "100%",
        },
        wrapper: { boxShadow: "none" },
      }}
    >
      <style>{`
        .canvas-sidebar .ant-drawer-header {
          position: relative;
          min-height: 40px;
        }
        /* 左侧抽屉：关闭按钮移到左上角（贴左边缘），符合常规 */
        .canvas-sidebar .ant-drawer-close {
          position: absolute !important;
          left: 12px !important;
          right: auto !important;
          top: 50% !important;
          transform: translateY(-50%) !important;
          margin: 0 !important;
        }
        .canvas-sidebar .ant-drawer-body {
          flex: 1;
          overflow: hidden;
        }
        .canvas-sidebar input.ant-input {
          background: var(--canvas-bg-elevated) !important;
          border-color: var(--canvas-border) !important;
          color: var(--canvas-text) !important;
          border-radius: 8px !important;
          height: 32px !important;
          font-size: 13px !important;
        }
        .canvas-sidebar input.ant-input:hover,
        .canvas-sidebar input.ant-input:focus {
          border-color: var(--canvas-border) !important;
          box-shadow: none !important;
        }
        .canvas-sidebar .ant-input-affix-wrapper {
          background: var(--canvas-bg-elevated) !important;
          border-color: var(--canvas-border) !important;
          border-radius: 8px !important;
          height: 32px !important;
        }
        .canvas-sidebar .ant-input-affix-wrapper .ant-input {
          background: transparent !important;
          border: none !important;
          height: 30px !important;
        }
        .canvas-sidebar .ant-input-affix-wrapper:hover,
        .canvas-sidebar .ant-input-affix-wrapper:focus,
        .canvas-sidebar .ant-input-affix-wrapper-focused {
          border-color: var(--canvas-border) !important;
          box-shadow: none !important;
        }
        .canvas-sidebar ::-webkit-scrollbar {
          width: 4px;
        }
        .canvas-sidebar ::-webkit-scrollbar-track {
          background: transparent;
        }
        .canvas-sidebar ::-webkit-scrollbar-thumb {
          background: var(--canvas-border);
          border-radius: 2px;
        }
      `}</style>

      <div className="canvas-sidebar flex flex-col h-full">
        {/* Tab 切换器 */}
        <div className="flex items-center border-b flex-shrink-0" style={{ borderColor: "var(--canvas-border)" }}>
          <button
            className="flex-1 flex items-center justify-center gap-1.5 py-3 text-sm font-medium transition-colors border-b-2"
            style={{
              background: "transparent",
              cursor: "pointer",
              color: activeTab === "elements" ? "var(--canvas-text)" : "var(--canvas-text-dim)",
              borderColor: activeTab === "elements" ? "#1677ff" : "transparent",
            }}
            onClick={() => setActiveTab("elements")}
          >
            <AppstoreOutlined />
            {t("canvas.tab.elements")}
          </button>
          <button
            className="flex-1 flex items-center justify-center gap-1.5 py-3 text-sm font-medium transition-colors border-b-2"
            style={{
              background: "transparent",
              cursor: "pointer",
              color: activeTab === "assets" ? "var(--canvas-text)" : "var(--canvas-text-dim)",
              borderColor: activeTab === "assets" ? "#1677ff" : "transparent",
            }}
            onClick={() => setActiveTab("assets")}
          >
            <InboxOutlined />
            {t("canvas.tab.assets")}
          </button>
        </div>

        {/* Tab 内容 */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab === "elements" ? <CanvasElementsView /> : <AssetsView />}
        </div>
      </div>
    </Drawer>
  );
}

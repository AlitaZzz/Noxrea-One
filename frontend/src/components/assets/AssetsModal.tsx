"use client";

import { useState, useMemo, useCallback } from "react";
import { Input, Button, Select } from "antd";
import { DatabaseOutlined, InboxOutlined, UserOutlined, FolderOutlined } from "@ant-design/icons";
import AppModal from "@/lib/app-modal";
import ModalButton from "@/components/common/ModalButton";
import ConfirmModal from "@/components/common/ConfirmModal";
import type { AssetType, AssetItem, CreateAssetInput } from "@/lib/types";
import { ASSET_CATEGORIES } from "@/lib/types";
import { useAssetsStore } from "@/stores/assets-store";
import { useCanvasStore } from "@/stores/canvas-store";
import { createImageNode, createVideoNode } from "@/lib/node-defaults";
import { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from "@/lib/constants";
import { computeNodeSize } from "@/lib/image-utils";
import { useI18nStore } from "@/stores/i18n-store";
import AssetSidebar from "./AssetSidebar";
import AssetToolbar from "./AssetToolbar";
import AssetCategoryTabs from "./AssetCategoryTabs";
import AssetGrid from "./AssetGrid";
import AssetCreateDialog from "./AssetCreateDialog";
import CreateFolderDialog from "./CreateFolderDialog";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AssetsModal({ open, onClose }: Props) {
  const t = useI18nStore((s) => s.t);
  const lang = useI18nStore((s) => s.lang);
  const items = useAssetsStore((s) => s.items);
  const folders = useAssetsStore((s) => s.folders);
  const addAssetsBatch = useAssetsStore((s) => s.addAssetsBatch);
  const addFolder = useAssetsStore((s) => s.addFolder);
  const updateAsset = useAssetsStore((s) => s.updateAsset);
  const removeAsset = useAssetsStore((s) => s.removeAsset);
  const updateAssetsBatch = useAssetsStore((s) => s.updateAssetsBatch);
  const getFiltered = useAssetsStore((s) => s.getFiltered);
  const getChildFolders = useAssetsStore((s) => s.getChildFolders);
  const addNodes = useCanvasStore((s) => s.addNodes);

  const [activeSpace, setActiveSpace] = useState("personal");
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [category, setCategory] = useState<AssetType | "all">("all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);

  // Rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Delete confirm state
  const [deleteAsset, setDeleteAsset] = useState<AssetItem | null>(null);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  const [batchTypeOpen, setBatchTypeOpen] = useState(false);
  const [batchTypeValue, setBatchTypeValue] = useState<AssetType>("character");
  const handleToggleSelect = useCallback((asset: AssetItem) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(asset.id)) {
        next.delete(asset.id);
      } else {
        next.add(asset.id);
      }
      return next;
    });
  }, []);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setDeleteAsset({
      id: String(selectedIds.size),
      name: `${selectedIds.size} ${t("asset.count")}`,
      type: "other",
      width: 0,
      height: 0,
      description: "",
      createdAt: 0,
      updatedAt: 0,
      tags: [],
      metadata: {},
      spaceKey: "personal",
    });
  }, [selectedIds, t]);

  const handleBatchDeleteConfirm = useCallback(() => {
    selectedIds.forEach((id) => removeAsset(id));
    setSelectedIds(new Set());
    setDeleteAsset(null);
  }, [selectedIds, removeAsset]);

  const handleBatchMove = useCallback((folderId: string) => {
    updateAssetsBatch([...selectedIds], { folderId: folderId || undefined });
    setSelectedIds(new Set());
    setBatchMoveOpen(false);
  }, [selectedIds, updateAssetsBatch]);

  const handleBatchType = useCallback((type: AssetType) => {
    updateAssetsBatch([...selectedIds], { type });
    setSelectedIds(new Set());
    setBatchTypeOpen(false);
  }, [selectedIds, updateAssetsBatch]);

  // Current folder depth (max 2 levels allowed)
  const currentFolderDepth = useMemo(() => {
    if (!activeFolderId) return 0;
    let depth = 0;
    let id: string | undefined = activeFolderId;
    while (id) {
      depth++;
      const f = folders.find((x) => x.id === id);
      id = f?.parentId || undefined;
    }
    return depth;
  }, [activeFolderId, folders]);
  const canCreateFolder = currentFolderDepth < 2;

  const filtered = useMemo(
    () => getFiltered(category, search, activeFolderId, activeSpace),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, category, search, activeFolderId, activeSpace, getFiltered],
  );

  const allSelected = filtered.length > 0 && filtered.every((a) => selectedIds.has(a.id));

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((a) => a.id)));
    }
  }, [allSelected, filtered]);

  const folderCounts = useMemo(() => {
    // Direct counts per folder
    const direct: Record<string, number> = {};
    for (const item of items) {
      if (item.folderId) {
        direct[item.folderId] = (direct[item.folderId] || 0) + 1;
      }
    }
    // Recursive: total = direct + sum of children's totals
    const cache: Record<string, number> = {};
    const getRecursive = (folderId: string): number => {
      if (cache[folderId] !== undefined) return cache[folderId];
      let total = direct[folderId] || 0;
      const children = folders.filter((f) => f.parentId === folderId);
      for (const child of children) {
        total += getRecursive(child.id);
      }
      cache[folderId] = total;
      return total;
    };
    const counts: Record<string, number> = {};
    for (const f of folders) {
      counts[f.id] = getRecursive(f.id);
    }
    return counts;
  }, [items, folders]);

  // --- Handlers ---

  const handleInsertCanvas = useCallback(
    (asset: AssetItem) => {
      const s = useCanvasStore.getState();
      const nw = asset.width || DEFAULT_NODE_WIDTH;
      const nh = asset.height || DEFAULT_NODE_HEIGHT;
      const { width: dw, height: dh } = computeNodeSize(nw, nh);
      const cx = -s.viewport.x / s.viewport.zoom + window.innerWidth / 2 / s.viewport.zoom;
      const cy = -s.viewport.y / s.viewport.zoom + window.innerHeight / 2 / s.viewport.zoom;

      // Check if this asset has a source URL (video/audio → VideoNode, image → ImageNode)
      const sourceUrl = asset.metadata?.sourceUrl as string | undefined;
      const isVideo = sourceUrl && (sourceUrl.endsWith(".mp4") || sourceUrl.endsWith(".webm") || sourceUrl.endsWith(".mov"));
      if (isVideo) {
        const node = createVideoNode({ x: cx - dw / 2, y: cy - dh / 2 }, sourceUrl);
        node.data.label = asset.name;
        node.data.alt = asset.name;
        node.data.naturalWidth = nw || 320;
        node.data.naturalHeight = nh || 180;
        node.style = { width: dw || DEFAULT_NODE_WIDTH, height: dh || DEFAULT_NODE_HEIGHT };
        addNodes([node]);
      } else {
        const imgSrc = asset.metadata?.sourceUrl as string;
        const node = createImageNode({ x: cx - dw / 2, y: cy - dh / 2 }, imgSrc);
        node.data.label = asset.name;
        node.data.alt = asset.name;
        node.data.naturalWidth = nw;
        node.data.naturalHeight = nh;
        node.style = { width: dw, height: dh };
        addNodes([node]);
      }
      onClose();
    },
    [addNodes, onClose],
  );

  const handleCreateAssets = useCallback(
    (inputs: CreateAssetInput[]) => {
      addAssetsBatch(inputs);
    },
    [addAssetsBatch],
  );

  const handleCreateFolder = useCallback(
    (name: string): boolean => {
      return addFolder(name, activeSpace, activeFolderId ?? undefined) !== null;
    },
    [addFolder, activeSpace, activeFolderId],
  );

  const handleRename = useCallback(
    (asset: AssetItem) => {
      setRenamingId(asset.id);
      setRenameValue(asset.name);
    },
    [],
  );

  const handleRenameConfirm = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      updateAsset(renamingId, { name: renameValue.trim() });
    }
    setRenamingId(null);
    setRenameValue("");
  }, [renamingId, renameValue, updateAsset]);

  const handleDelete = useCallback(
    (asset: AssetItem) => {
      setDeleteAsset(asset);
    },
    [],
  );

  const handleSelectSpace = useCallback((key: string) => {
    setActiveSpace(key);
    setActiveFolderId(null);
    setSelectedIds(new Set());
  }, []);

  const handleSelectFolder = useCallback((id: string | null) => {
    setActiveFolderId(id);
    setSelectedIds(new Set());
  }, []);

  // i18n-aware space labels
  const spaceLabels = useMemo(
    () => [
      { key: "personal", label: t("asset.space.personal"), icon: <UserOutlined /> },
      { key: "reusable", label: t("asset.space.reusable"), icon: <DatabaseOutlined /> },
    ],
    [t, lang],
  );


  return (
    <>
      <AppModal
        title={
          <div className="flex items-center gap-2">
            <InboxOutlined style={{ color: "var(--canvas-text-secondary)" }} />
            <span style={{ color: "var(--canvas-text)", fontSize: 16, fontWeight: 600 }}>{t("asset.title")}</span>
          </div>
        }
        open={open}
        onCancel={onClose}
        footer={null}
        width="90vw"
        centered
        destroyOnHidden
        className="asset-library-modal"
        styles={{
            header: { background: "var(--canvas-bg)" },
          body: { background: "var(--canvas-bg)", padding: 0, maxHeight: "calc(100vh - 140px)", overflow: "hidden" },
        }}
        style={{ maxWidth: 1200 }}
        closeIcon={
          <span style={{ color: "var(--canvas-text-secondary)" }}>✕</span>
        }
      >
        <style>{`
          .menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }
          .asset-library-modal .ant-input:hover,
          .asset-library-modal .ant-input:focus,
          .asset-library-modal .ant-input-focused,
          .asset-library-modal .ant-input-affix-wrapper:hover,
          .asset-library-modal .ant-input-affix-wrapper:focus,
          .asset-library-modal .ant-input-affix-wrapper-focused,
          .asset-library-modal .ant-select-selector:hover,
          .asset-library-modal .ant-select-focused .ant-select-selector {
            border-color: var(--canvas-border) !important;
            box-shadow: none !important;
          }
          .ant-modal-confirm .ant-modal-mask {
            background: rgba(0,0,0,0.6) !important;
          }
        `}</style>
        <div className="flex" style={{ height: "calc(85vh - 160px)", minHeight: 400 }}>
          {/* Left sidebar */}
          <div
            className="flex flex-col py-4 border-r shrink-0"
            style={{ borderColor: "var(--canvas-border)", paddingLeft: 0, paddingRight: 16 }}
          >
            <AssetSidebar
              spaces={spaceLabels}
              activeSpace={activeSpace}
              activeFolderId={activeFolderId}
              onSelectSpace={handleSelectSpace}
              onSelectFolder={handleSelectFolder}
              folders={folders}
              folderCounts={folderCounts}
            />
          </div>

          {/* Right main content */}
          <div className="flex-1 flex flex-col py-4 pr-4 pl-4 min-w-0">
            {/* Toolbar */}
            <AssetToolbar
              search={search}
              onSearchChange={setSearch}
              selectedCount={selectedIds.size}
              allSelected={allSelected}
              onSelectAll={handleSelectAll}
              onBatchDelete={handleBatchDelete}
              onBatchMove={() => setBatchMoveOpen(true)}
              onBatchType={() => setBatchTypeOpen(true)}
              onUpload={() => setCreateOpen(true)}
              onCreateFolder={() => setFolderCreateOpen(true)}
              canCreateFolder={canCreateFolder}
            />

            {/* Category tabs */}
            <AssetCategoryTabs active={category} onChange={setCategory} />

            {/* Grid */}
            <div className="flex-1 overflow-auto min-h-0" style={{ paddingRight: 8 }}>
              <AssetGrid
                assets={filtered}
                folders={getChildFolders(activeSpace, activeFolderId ?? undefined)}
                folderCounts={folderCounts}
                selectedIds={selectedIds}
                onToggleSelect={handleToggleSelect}
                onInsertCanvas={handleInsertCanvas}
                onRename={handleRename}
                onDelete={handleDelete}
                onEnterFolder={(folder) => setActiveFolderId(folder.id)}
              />
            </div>
          </div>
        </div>

        {/* Rename modal — nested inside main LayerModal (depth=2) */}
        <AppModal
          title={<span style={{ color: "var(--canvas-text)", fontSize: 16, fontWeight: 600 }}>{t("asset.rename")}</span>}
          open={!!renamingId}
          onCancel={() => setRenamingId(null)}
          centered
          destroyOnHidden
          width={400}
          className="rename-modal"
          footer={
            <div className="flex justify-end gap-2">
              <ModalButton onClick={() => setRenamingId(null)}>{t("cancel")}</ModalButton>
              <ModalButton variant="primary" onClick={handleRenameConfirm} disabled={!renameValue.trim()}>{t("save")}</ModalButton>
            </div>
          }
          styles={{
                header: { background: "var(--canvas-bg)", borderBottom: "none", paddingBottom: 12 },
            body: { background: "var(--canvas-bg)", padding: "20px 24px 8px" },
            footer: { background: "var(--canvas-bg)", borderTop: "none", paddingTop: 0 },
          }}
          closeIcon={<span style={{ color: "var(--canvas-text-secondary)" }}>✕</span>}
        >
          <style>{`
            .rename-modal .ant-input:hover,
            .rename-modal .ant-input:focus,
            .rename-modal .ant-input-affix-wrapper:hover,
            .rename-modal .ant-input-affix-wrapper:focus {
              border-color: var(--canvas-border) !important;
              box-shadow: none !important;
            }
            .rename-modal .rename-save-btn:not(:disabled):hover {
              background: #e6e6e6 !important;
            }
          `}</style>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value.slice(0, 100))}
            onPressEnter={handleRenameConfirm}
            maxLength={100}
            showCount
            style={{
              background: "var(--canvas-bg-elevated)",
              borderColor: "var(--canvas-border)",
              color: "var(--canvas-text)",
            }}
          />
        </AppModal>

        {/* Delete confirm — nested inside main LayerModal (depth=2) */}
        <ConfirmModal
          open={!!deleteAsset}
          title={t("delete.asset")}
          content={deleteAsset?.name || ""}
          onOk={() => {
            if (!deleteAsset) return;
            if (selectedIds.size > 0) {
              handleBatchDeleteConfirm();
            } else {
              removeAsset(deleteAsset.id);
              setDeleteAsset(null);
            }
          }}
          onCancel={() => { setDeleteAsset(null); setSelectedIds(new Set()); }}
        />

        {/* Batch move modal */}
        <AppModal
          title={<span style={{ color: "var(--canvas-text)", fontSize: 16, fontWeight: 600 }}>{t("asset.moveTo")}</span>}
          open={batchMoveOpen}
          onCancel={() => setBatchMoveOpen(false)}
          centered
          destroyOnHidden
          width={360}
          footer={
            <div className="flex justify-end gap-2">
              <ModalButton onClick={() => setBatchMoveOpen(false)}>{t("cancel")}</ModalButton>
            </div>
          }
          styles={{
                header: { background: "var(--canvas-bg)", borderBottom: "none", paddingBottom: 12 },
            body: { background: "var(--canvas-bg)", padding: "12px 24px" },
            footer: { background: "var(--canvas-bg)", borderTop: "none", paddingTop: 0 },
          }}
        >
          <div className="flex flex-col gap-1.5 max-h-60 overflow-auto">
            <button
              onClick={() => handleBatchMove("")}
              className="flex items-center gap-2 py-2 px-3 rounded-md text-sm transition-colors hover:bg-white/5 w-full text-left"
              style={{ color: "var(--canvas-text)" }}
            >
              <FolderOutlined style={{ color: "var(--canvas-text-muted)" }} />
              {t("asset.space.personal")}
            </button>
            {(() => {
              const personalFolders = folders.filter((f) => f.spaceKey === "personal");
              const buildTree = (parentId: string | undefined, depth: number): React.ReactNode[] => {
                const children = personalFolders.filter((f) => (f.parentId || undefined) === parentId);
                return children.flatMap((f) => [
                  <button
                    key={f.id}
                    onClick={() => handleBatchMove(f.id)}
                    className="flex items-center gap-2 py-2 px-3 rounded-md text-sm transition-colors hover:bg-white/5 w-full text-left"
                    style={{ color: "var(--canvas-text)", paddingLeft: 24 + depth * 16 }}
                  >
                    <FolderOutlined style={{ color: "var(--canvas-text-muted)" }} />
                    {f.name}
                  </button>,
                  ...buildTree(f.id, depth + 1),
                ]);
              };
              return buildTree(undefined, 0);
            })()}
          </div>
        </AppModal>

        {/* Batch type modal */}
        <AppModal
          title={<span style={{ color: "var(--canvas-text)", fontSize: 16, fontWeight: 600 }}>{t("asset.changeType")}</span>}
          open={batchTypeOpen}
          onCancel={() => setBatchTypeOpen(false)}
          centered
          destroyOnHidden
          width={360}
          footer={
            <div className="flex justify-end gap-2">
              <ModalButton onClick={() => setBatchTypeOpen(false)}>{t("cancel")}</ModalButton>
              <ModalButton variant="primary" onClick={() => handleBatchType(batchTypeValue)}>{t("save")}</ModalButton>
            </div>
          }
          styles={{
                header: { background: "var(--canvas-bg)", borderBottom: "none", paddingBottom: 12 },
            body: { background: "var(--canvas-bg)", padding: "12px 24px" },
            footer: { background: "var(--canvas-bg)", borderTop: "none", paddingTop: 0 },
          }}
        >
          <style>{`
          `}</style>
          <Select
            value={batchTypeValue}
            onChange={(v) => setBatchTypeValue(v)}
            getPopupContainer={(t) => t.parentElement || document.body}
            style={{ width: "100%" }}
            options={ASSET_CATEGORIES.filter((c) => c.key !== "all").map((cat) => ({
              value: cat.key,
              label: t(cat.labelKey),
            }))}
          />
        </AppModal>

        {/* Upload dialog — nested inside main LayerModal (depth=2) */}
        <AssetCreateDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreate={handleCreateAssets}
          folders={folders}
        />

        {/* Create folder dialog — nested inside main LayerModal (depth=2) */}
        <CreateFolderDialog
          open={folderCreateOpen}
          onClose={() => setFolderCreateOpen(false)}
          onCreate={handleCreateFolder}
        />
      </AppModal>
    </>
  );
}

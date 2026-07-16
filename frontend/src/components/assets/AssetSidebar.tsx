"use client";

import type { ReactNode } from "react";
import { FolderOutlined } from "@ant-design/icons";
import type { AssetFolder } from "@/lib/types";
import { useI18nStore } from "@/stores/i18n-store";

interface SpaceItem {
  key: string;
  label: string;
  icon: ReactNode;
}

interface Props {
  spaces: SpaceItem[];
  activeSpace: string;
  activeFolderId: string | null;
  onSelectSpace: (key: string) => void;
  onSelectFolder: (folderId: string | null) => void;
  folders: AssetFolder[];
  folderCounts: Record<string, number>;
}

function FolderTree({
  folders,
  parentId,
  activeFolderId,
  onSelectFolder,
  depth,
  folderCounts,
  t,
}: {
  folders: AssetFolder[];
  parentId: string | undefined;
  activeFolderId: string | null;
  onSelectFolder: (id: string) => void;
  depth: number;
  folderCounts: Record<string, number>;
  t: (key: string) => string;
}) {
  const children = folders.filter((f) => (f.parentId || undefined) === parentId);
  if (children.length === 0) return null;

  return (
    <>
      {children.map((f) => (
        <div key={f.id}>
          <button
            onClick={(e) => { e.stopPropagation(); onSelectFolder(f.id); }}
            className="sidebar-folder-btn flex items-center gap-2 py-1.5 text-sm rounded-md transition-colors w-full"
            style={{
              background: activeFolderId === f.id ? "var(--canvas-bg-elevated)" : "transparent",
              color: activeFolderId === f.id ? "var(--canvas-text)" : "var(--canvas-text-secondary)",
              paddingLeft: 28 + depth * 16,
              paddingRight: 10,
            }}
          >
            <FolderOutlined className="text-xs flex-shrink-0" style={{ color: "var(--canvas-text-muted)" }} />
            <span className="flex-1 text-left truncate">{f.name}</span>
            <span className="text-xs text-white/30">{folderCounts[f.id] || 0} {t("asset.count")}</span>
          </button>
          <FolderTree
            folders={folders}
            parentId={f.id}
            activeFolderId={activeFolderId}
            onSelectFolder={onSelectFolder}
            depth={depth + 1}
            folderCounts={folderCounts}
            t={t}
          />
        </div>
      ))}
    </>
  );
}

export default function AssetSidebar({ spaces, activeSpace, activeFolderId, onSelectSpace, onSelectFolder, folders, folderCounts }: Props) {
  const t = useI18nStore((s) => s.t);
  const spaceFolders = folders.filter((f) => f.spaceKey === activeSpace && !f.parentId);

  return (
    <div className="flex flex-col shrink-0 gap-0.5" style={{ width: 160 }}>
      <style>{`
        .sidebar-space-btn { cursor: pointer; }
        .sidebar-folder-btn { cursor: pointer; }
        .sidebar-space-btn:hover { background: var(--canvas-bg-hover) !important; }
        .sidebar-folder-btn:hover { background: var(--canvas-bg-hover) !important; }
      `}</style>
      {spaces.map((sp) => (
        <div key={sp.key}>
          <button
            onClick={() => {
              onSelectSpace(sp.key);
              onSelectFolder(null);
            }}
            className="sidebar-space-btn flex items-center gap-2 py-2 text-sm rounded-md transition-colors w-full"
            style={{
              background: activeSpace === sp.key && activeFolderId === null ? "var(--canvas-bg-elevated)" : "transparent",
              color: activeSpace === sp.key && activeFolderId === null ? "var(--canvas-text)" : "var(--canvas-text-secondary)",
              paddingLeft: 10,
              paddingRight: 10,
            }}
          >
            <span className="text-base leading-none opacity-60">{sp.icon}</span>
            <span>{sp.label}</span>
          </button>
          {activeSpace === sp.key && spaceFolders.length > 0 && (
            <FolderTree
              folders={folders}
              parentId={undefined}
              activeFolderId={activeFolderId}
              onSelectFolder={onSelectFolder}
              depth={0}
              folderCounts={folderCounts}
              t={t}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * 资产库导航栏（Navigation）。
 * 上部为空间切换（个人 / 公共等），下部以递归树形展示文件夹层级与资产计数，
 * 支持选中定位与删除文件夹。
 */
"use client";

import { FolderOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";

import NavButton from "@/components/common/NavButton";
import type { AssetFolder } from "@/lib/types/assets";
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
  onDeleteFolder?: (folder: AssetFolder) => void;
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
        <div key={f.id} className="group relative">
          <NavButton
            onClick={(e) => { e?.stopPropagation(); onSelectFolder(f.id); }}
            active={activeFolderId === f.id}
            style={{ padding: "5px 10px 5px " + (28 + depth * 16) + "px" }}
          >
            <FolderOutlined className="text-xs flex-shrink-0" style={{ color: "var(--canvas-text-muted)" }} />
            <span className="flex-1 text-left truncate">{f.name}</span>
            <span className="text-xs text-white/30">{folderCounts[f.id] || 0} {t("asset.count")}</span>
          </NavButton>
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

export default function AssetNav({ spaces, activeSpace, activeFolderId, onSelectSpace, onSelectFolder, folders, folderCounts, onDeleteFolder }: Props) {
  const t = useI18nStore((s) => s.t);
  const spaceFolders = folders.filter((f) => f.spaceKey === activeSpace && !f.parentId);

  return (
    <div className="flex flex-col shrink-0 gap-0.5" style={{ width: 160 }}>
      {spaces.map((sp) => (
        <div key={sp.key}>
          <NavButton
            onClick={() => { onSelectSpace(sp.key); onSelectFolder(null); }}
            active={activeSpace === sp.key && activeFolderId === null}
            style={{ padding: "6px 10px" }}
          >
            <span className="text-base leading-none opacity-60">{sp.icon}</span>
            <span>{sp.label}</span>
          </NavButton>
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

/**
 * 资产库导航栏（Navigation）。
 * 上部为空间切换（个人 / 公共等），下部以递归树形展示文件夹层级与资产计数，
 * 支持选中定位。文件夹的重命名 / 删除入口放在网格中的文件夹卡片上，树保持纯导航。
 */
"use client";

import { FolderOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import NavButton from "@/components/ui/NavButton";
import type { AssetFolder, AssetScope } from "@/features/assets/types";

interface ScopeItem {
  key: AssetScope;
  label: string;
  icon: ReactNode;
}

interface Props {
  scopes: ScopeItem[];
  activeScope: AssetScope;
  activeFolderId: string | null;
  onSelectScope: (scope: AssetScope) => void;
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
      {children.map((f) => {
        const protectedFolder = f.kind === "uncategorized";
        return (
          <div key={f.id}>
            <NavButton
              onClick={(e) => { e?.stopPropagation(); onSelectFolder(f.id); }}
              active={activeFolderId === f.id}
              style={{ padding: "5px 10px 5px " + (28 + depth * 16) + "px" }}
            >
              <FolderOutlined className="text-xs flex-shrink-0" style={{ color: "var(--canvas-text-muted)" }} />
              <span className="flex-1 text-left truncate">
                {protectedFolder ? t("asset.uncategorized") : f.name}
              </span>
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
        );
      })}
    </>
  );
}

export default function AssetNav({ scopes, activeScope, activeFolderId, onSelectScope, onSelectFolder, folders, folderCounts }: Props) {
  const { t } = useTranslation();
  const scopeFolders = folders.filter((f) => f.scope === activeScope && !f.parentId);

  return (
    <div className="flex flex-col shrink-0 gap-0.5" style={{ width: 160 }}>
      {scopes.map((scope) => (
        <div key={scope.key}>
          <NavButton
            onClick={() => { onSelectScope(scope.key); onSelectFolder(null); }}
            active={activeScope === scope.key && activeFolderId === null}
            style={{ padding: "6px 10px" }}
          >
            <span className="text-base leading-none opacity-60">{scope.icon}</span>
            <span>{scope.label}</span>
          </NavButton>
          {activeScope === scope.key && scopeFolders.length > 0 && (
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

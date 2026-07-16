"use client";

import { FolderOpenOutlined } from "@ant-design/icons";
import type { AssetFolder } from "@/lib/types";
import { useI18nStore } from "@/stores/i18n-store";

interface Props {
  folder: AssetFolder;
  count?: number;
  onClick: (folder: AssetFolder) => void;
}

export default function FolderCard({ folder, count, onClick }: Props) {
  const t = useI18nStore((s) => s.t);

  return (
    <div
      onClick={() => onClick(folder)}
      className="relative group rounded-lg overflow-hidden border border-white/10 hover:border-white/30 transition-all cursor-pointer flex flex-col items-center justify-center gap-2"
      style={{ background: "var(--canvas-bg-elevated)", aspectRatio: "1" }}
    >
      <FolderOpenOutlined style={{ fontSize: 40, color: "rgba(255,255,255,0.25)" }} />
      <div className="text-white/70 text-xs px-2 text-center truncate w-full">{folder.name}</div>
      <div className="text-white/25 text-[10px]">{count ?? 0} {t("asset.count")}</div>
    </div>
  );
}

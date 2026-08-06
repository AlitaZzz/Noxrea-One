/**
 * 资产分类切换页签。
 * 基于 ASSET_CATEGORIES 渲染受控的 Segmented 分段控件，纯展示无业务逻辑。
 */
"use client";

import { Segmented } from "antd";

import { ASSET_CATEGORIES } from "@/lib/constants";
import type { AssetType } from "@/features/assets/types";
import { useI18nStore } from "@/lib/i18n/store";

interface Props {
  active: AssetType | "all";
  onChange: (key: AssetType | "all") => void;
}

export default function AssetCategoryTabs({ active, onChange }: Props) {
  const t = useI18nStore((s) => s.t);

  return (
    <div className="mb-3 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
      <style>{`
        .asset-cat-tabs .ant-segmented-group {
          gap: 12px;
        }
      `}</style>
      <Segmented
        className="asset-cat-tabs"
        value={active}
        onChange={(val) => onChange(val as AssetType | "all")}
        options={ASSET_CATEGORIES.map((cat) => ({
          value: cat.key,
          label: t(cat.labelKey),
        }))}
        style={{
          background: "var(--canvas-bg-elevated)",
          padding: 4,
        }}
      />
    </div>
  );
}

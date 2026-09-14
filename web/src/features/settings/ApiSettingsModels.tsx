/**
 * API 设置抽屉 · 模型区。
 * 能力筛选 chips + 搜索 + 批量菜单 + 手动添加，虚拟列表按「已启用 / 可用」分组渲染；
 * 每行四个能力 pill 直接点选开关，无需切换 tab（取代旧的 tab + checkbox 两步操作）。
 */
"use client";

import {
  DownloadOutlined,
  EllipsisOutlined,
  PictureOutlined,
  PlusOutlined,
  SearchOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { Input } from "antd";
import type { ComponentType, CSSProperties } from "react";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import { ModelIcon } from "@/components/ui/ModelIcon";
import { VirtualList } from "@/components/ui/VirtualList";
import { useModelStore } from "@/lib/model-store";
import type { ModelCapability, ModelInfo, ModelProvider } from "@/lib/types/models";

/** 模块级常量（稳定引用，避免每次渲染重建导致虚拟列表失效）。
    图标语义沿用画布：声波 = 音频，不用 antd 的麦克风。 */
const CAP_PILLS: { cap: ModelCapability; Icon: ComponentType<{ className?: string; style?: CSSProperties }> }[] = [
  { cap: "text", Icon: TextIcon },
  { cap: "image", Icon: PictureOutlined },
  { cap: "video", Icon: VideoCameraOutlined },
  { cap: "audio", Icon: WaveIcon },
];

/** 单行（已 memo）：仅在 m / dim / onToggle 变化时才重渲染。
    dim = 该行在当前筛选下未启用（字色降级，不参与选中语义）。 */
const ModelRow = memo(function ModelRow({
  m,
  dim,
  onToggle,
}: {
  m: ModelInfo;
  dim: boolean;
  onToggle: (id: string, cap: ModelCapability) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 px-3 h-full">
      <ModelIcon model={m.name} className="text-xs shrink-0" style={{ color: "var(--canvas-text-muted)" }} />
      <span
        className="flex-1 min-w-0 truncate text-[13px]"
        style={{ color: dim ? "var(--canvas-text-dim)" : "var(--canvas-text)" }}
      >
        {m.name}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        {CAP_PILLS.map(({ cap, Icon }) => {
          const on = !!m.capabilities?.includes(cap);
          return (
            <button
              key={cap}
              type="button"
              className="cap-pill"
              aria-pressed={on}
              aria-label={t(`modelConfig.cap.${cap}`)}
              onClick={() => onToggle(m.id, cap)}
            >
              <Icon />
            </button>
          );
        })}
      </div>
    </div>
  );
});

interface Props {
  provider: ModelProvider;
  /** 拉取模型（按钮在详情头，空模型态的内联按钮复用同一回调） */
  onFetch: () => void;
  fetching: boolean;
}

export default function ApiSettingsModels({ provider, onFetch, fetching }: Props) {
  const { t } = useTranslation();
  const toggleModelCapability = useModelStore((s) => s.toggleModelCapability);
  const setProviderModels = useModelStore((s) => s.setProviderModels);

  const [filter, setFilter] = useState<"all" | ModelCapability>("all");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);

  // 各能力计数（筛选 chips 角标）
  const capCounts: Record<ModelCapability, number> = { text: 0, image: 0, video: 0, audio: 0 };
  for (const m of provider.models) {
    for (const c of m.capabilities || []) capCounts[c]++;
  }

  const q = search.trim().toLowerCase();
  const matches = (m: ModelInfo) => !q || m.name.toLowerCase().includes(q);
  const isEnabled = (m: ModelInfo) =>
    filter === "all" ? (m.capabilities?.length ?? 0) > 0 : !!m.capabilities?.includes(filter);
  const enabledModels = provider.models.filter((m) => matches(m) && isEnabled(m));
  const otherModels = provider.models.filter((m) => matches(m) && !isEnabled(m));

  // 合并为带分组头的扁平数组，交给虚拟列表渲染
  type Row =
    | { kind: "header"; key: string; label: string }
    | { kind: "model"; key: string; m: ModelInfo; dim: boolean };
  const rows: Row[] = [];
  if (enabledModels.length > 0) {
    rows.push({ kind: "header", key: "h-on", label: `${t("modelConfig.enabled")} (${enabledModels.length})` });
    for (const m of enabledModels) rows.push({ kind: "model", key: m.id, m, dim: false });
  }
  if (otherModels.length > 0) {
    rows.push({ kind: "header", key: "h-off", label: `${t("modelConfig.available")} (${otherModels.length})` });
    for (const m of otherModels) rows.push({ kind: "model", key: m.id, m, dim: true });
  }

  // 切换单行能力；失败时 store 会提示并回滚（本地不写入），这里兜住网络异常
  const onToggle = (modelId: string, cap: ModelCapability) => {
    toggleModelCapability(provider.id, modelId, cap).catch(() => {});
  };

  // 批量操作目标：当前筛选 + 搜索后可见的全部模型。
  // 本地算好全量 capabilities，一次 set_models 提交。
  const visibleModels = [...enabledModels, ...otherModels];
  const batchApply = async (nextCapsForVisible: (m: ModelInfo) => ModelCapability[]) => {
    if (visibleModels.length === 0) return;
    const visibleIds = new Set(visibleModels.map((m) => m.id));
    const merged = provider.models.map((m) => ({
      name: m.name,
      capabilities: visibleIds.has(m.id) ? nextCapsForVisible(m) : (m.capabilities || []),
    }));
    await setProviderModels(provider.id, merged).catch(() => {
      // 失败原因由 store 提示；这里只需避免未处理的 rejection
    });
  };
  const batchSelectAll = () =>
    batchApply((m) =>
      filter === "all"
        ? m.capabilities || []
        : Array.from(new Set([...(m.capabilities || []), filter]))
    );
  const batchClear = () =>
    batchApply((m) => (filter === "all" ? [] : (m.capabilities || []).filter((c) => c !== filter)));

  const handleAddModel = async () => {
    const name = newModelName.trim();
    if (!name) return;
    try {
      // 失败不清空输入框，避免用户刚填的模型名丢失
      if (await useModelStore.getState().addModel(provider.id, name)) setNewModelName("");
    } catch {
      // 异常已由全局流程处理
    }
  };

  const chips: { key: "all" | ModelCapability; label: string; count: number }[] = [
    { key: "all", label: t("modelConfig.filterAll"), count: provider.models.length },
    ...CAP_PILLS.map(({ cap }) => ({
      key: cap,
      label: t(`modelConfig.cap.${cap}`),
      count: capCounts[cap],
    })),
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 能力筛选 chips */}
      <div className="flex items-center flex-wrap gap-1 px-4 pt-3">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className="cap-chip"
            data-active={filter === chip.key}
            onClick={() => setFilter(chip.key)}
          >
            {chip.label}
            <span className="cap-chip-count">{chip.count}</span>
          </button>
        ))}
      </div>

      {/* 搜索 + 批量 + 手动添加 */}
      <div className="flex items-center gap-1.5 px-4 py-2.5">
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: "var(--canvas-text-muted)" }} />}
          placeholder={t("modelConfig.searchModel")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1"
        />
        <AppButton
          size="sm"
          variant="ghost"
          iconOnly
          aria-label={t("modelConfig.addModel")}
          data-active={adding}
          onClick={() => setAdding((v) => !v)}
        >
          <PlusOutlined />
        </AppButton>
        <MenuPopover
          trigger={
            <AppButton size="sm" variant="ghost" iconOnly aria-label={t("modelConfig.batch")}>
              <EllipsisOutlined />
            </AppButton>
          }
          open={batchOpen}
          onOpenChange={setBatchOpen}
          content={
            filter === "all" ? (
              <MenuItem dimmed>{t("modelConfig.batchNeedFilter")}</MenuItem>
            ) : (
              <>
                <MenuItem
                  onClick={() => {
                    setBatchOpen(false);
                    batchSelectAll();
                  }}
                >
                  {t("modelConfig.batchSelectShown")}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setBatchOpen(false);
                    batchClear();
                  }}
                >
                  {t("modelConfig.batchClearShown")}
                </MenuItem>
              </>
            )
          }
        />
      </div>

      {/* 手动添加输入行（＋ 按钮展开） */}
      {adding && (
        <div className="flex items-center gap-1.5 px-4 pb-2.5">
          <Input
            autoFocus
            placeholder={t("modelConfig.addModelPlaceholder")}
            value={newModelName}
            onChange={(e) => setNewModelName(e.target.value)}
            onPressEnter={handleAddModel}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAdding(false);
            }}
            className="flex-1"
          />
          <AppButton size="sm" variant="ghost" onClick={() => setAdding(false)}>
            {t("common.cancel")}
          </AppButton>
          <AppButton size="sm" variant="primary" disabled={!newModelName.trim()} onClick={handleAddModel}>
            {t("common.add")}
          </AppButton>
        </div>
      )}

      {/* 模型列表 / 空态 */}
      {provider.models.length === 0 ? (
        <div
          className="flex-1 flex flex-col items-center justify-center gap-1.5 pb-8 text-center"
          style={{ color: "var(--canvas-text-muted)" }}
        >
          <div className="text-sm" style={{ color: "var(--canvas-text-dim)" }}>{t("modelConfig.noModels")}</div>
          <div className="text-xs">{t("modelConfig.noModelsDesc")}</div>
          <AppButton size="sm" variant="primary" className="mt-2" onClick={onFetch} loading={fetching}>
            <DownloadOutlined />
            {t("modelConfig.fetchModels")}
          </AppButton>
        </div>
      ) : rows.length === 0 ? (
        <div
          className="flex-1 flex items-center justify-center text-[13px]"
          style={{ color: "var(--canvas-text-muted)" }}
        >
          {t("modelConfig.noMatchModels")}
        </div>
      ) : (
        <div className="flex-1 min-h-0 px-1.5 pb-2 flex flex-col">
          {/* 虚拟列表：仅渲染可视区行；搜索已在数据层完成（rows 已是过滤后结果） */}
          <VirtualList
            items={rows}
            itemHeight={36}
            rowKey={(r) => r.key}
            className="flex-1 min-h-0"
            renderItem={(r) =>
              r.kind === "header" ? (
                <div
                  className="flex items-center px-2 h-full text-[12px] font-medium"
                  style={{ color: "var(--canvas-text-muted)" }}
                >
                  {r.label}
                </div>
              ) : (
                <ModelRow m={r.m} dim={r.dim} onToggle={onToggle} />
              )
            }
          />
        </div>
      )}
    </div>
  );
}

/**
 * API 设置抽屉 · 模型区。
 * 能力筛选 chips + 搜索 + 批量菜单 + 手动添加，虚拟列表按「已启用 / 可用」分组渲染；
 * 每行四个能力 pill 直接点选开关，无需切换 tab（取代旧的 tab + checkbox 两步操作）。
 */

"use client";

import type { ComponentType } from "react";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CheckOutlined,
  CloseOutlined,
  DownloadOutlined,
  EllipsisOutlined,
  PictureOutlined,
  PlusOutlined,
  TextIcon,
  VideoCameraOutlined,
} from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/input-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VirtualList } from "@/components/ui/VirtualList";
import { ModelIcon } from "@/features/model/ModelIcon";
import { NODE_TYPE, NODE_TYPE_COLOR } from "@/lib/constants";
import { useModelStore } from "@/lib/model-store";
import type { ModelCapability, ModelInfo, ModelProvider } from "@/lib/types/models";

/** 模块级常量（稳定引用，避免每次渲染重建导致虚拟列表失效） */
const CAP_PILLS: { cap: ModelCapability; Icon: ComponentType<{ className?: string }> }[] = [
  { cap: "text", Icon: TextIcon },
  { cap: "image", Icon: PictureOutlined },
  { cap: "video", Icon: VideoCameraOutlined },
];

const CAPABILITY_COLORS: Record<ModelCapability, string> = {
  text: NODE_TYPE_COLOR[NODE_TYPE.TEXT],
  image: NODE_TYPE_COLOR[NODE_TYPE.IMAGE],
  video: NODE_TYPE_COLOR[NODE_TYPE.VIDEO],
};

/** 单行（已 memo）：仅在 m / dim / onToggle / onDelete 变化时才重渲染。
    dim = 该行在当前筛选下未启用（字色降级，不参与选中语义）。
    悬停行尾出现删除 ×；点击后本行内变为青柠对勾二次确认，移出行即取消。 */
const ModelRow = memo(function ModelRow({
  m,
  dim,
  onToggle,
  onDelete,
}: {
  m: ModelInfo;
  dim: boolean;
  onToggle: (id: string, cap: ModelCapability) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      className="group flex h-full items-center gap-2 px-3"
      onMouseLeave={() => confirming && setConfirming(false)}
    >
      <ModelIcon model={m.name} className="shrink-0 text-xs text-muted-foreground" />
      <span
        className={`min-w-0 flex-1 truncate text-sm ${dim ? "text-muted-foreground" : "text-foreground"}`}
      >
        {m.name}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        {CAP_PILLS.map(({ cap, Icon }) => {
          const on = !!m.capabilities?.includes(cap);
          return (
            <Button
              key={cap}
              type="button"
              size="icon-xs"
              variant="ghost"
              className="hover:bg-muted"
              aria-pressed={on}
              aria-label={t(`modelConfig.cap.${cap}`)}
              style={on ? {
                color: CAPABILITY_COLORS[cap],
                backgroundColor: `color-mix(in srgb, ${CAPABILITY_COLORS[cap]} 15%, transparent)`,
              } : undefined}
              onClick={() => onToggle(m.id, cap)}
            >
              <Icon className="size-3" />
            </Button>
          );
        })}
      </div>
      {/* 删除只出现在未启用任何能力的行：已启用的行显示 × 会被误读为「停用」。
          占位符保持 22px 槽位，保证启用 / 未启用行的能力 pill 垂直对齐。 */}
      {(m.capabilities?.length ?? 0) === 0 ? (
        <Button
          type="button"
          size="icon-xs"
          variant="destructive"
          aria-label={confirming ? t("common.delete") : t("modelConfig.deleteModel")}
          className={`shrink-0 ${confirming ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          onClick={() => (confirming ? onDelete(m.id) : setConfirming(true))}
        >
          {confirming ? <CheckOutlined className="size-3" /> : <CloseOutlined className="size-3" />}
        </Button>
      ) : (
        <span aria-hidden className="w-[22px] shrink-0" />
      )}
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
  const capCounts: Record<ModelCapability, number> = { text: 0, image: 0, video: 0 };
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

  // 删除模型（行内二次确认后触发）；失败时行仍在列表，store 统一提示
  const onDelete = (modelId: string) => {
    useModelStore.getState().deleteModel(provider.id, modelId).catch(() => {});
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

  const renderModelContent = () => (
    <>
      {/* 搜索 + 批量 + 手动添加 */}
      <div className="flex items-center gap-1.5 px-4 py-2.5">
        <SearchInput
          placeholder={t("modelConfig.searchModel")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          clearable
          onClear={() => setSearch("")}
          className="flex-1"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("modelConfig.addModel")}
          data-active={adding}
          onClick={() => setAdding((v) => !v)}
        >
          <PlusOutlined className="size-4" />
        </Button>
        <DropdownMenu open={batchOpen} onOpenChange={setBatchOpen}>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={t("modelConfig.batch")}>
              <EllipsisOutlined className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end">
            {filter === "all" ? (
              <DropdownMenuItem disabled>{t("modelConfig.batchNeedFilter")}</DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onSelect={batchSelectAll}>{t("modelConfig.batchSelectShown")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={batchClear}>{t("modelConfig.batchClearShown")}</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 手动添加输入行（＋ 按钮展开） */}
      {adding && (
        <div className="flex items-center gap-1.5 px-4 pb-2.5">
          <Input
            autoFocus
            placeholder={t("modelConfig.addModelPlaceholder")}
            value={newModelName}
            onChange={(e) => setNewModelName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAddModel();
              if (e.key === "Escape") setAdding(false);
            }}
            className="flex-1"
          />
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="default" disabled={!newModelName.trim()} onClick={handleAddModel}>
            {t("common.add")}
          </Button>
        </div>
      )}

      {/* 模型列表 / 空态 */}
      {provider.models.length === 0 ? (
        <Empty className="h-auto min-h-0 flex-1 gap-1.5 rounded-none border-0 p-0 pb-8">
          <EmptyDescription className="text-sm text-muted-foreground">{t("modelConfig.noModels")}</EmptyDescription>
          <EmptyDescription className="text-xs">{t("modelConfig.noModelsDesc")}</EmptyDescription>
          <Button size="sm" variant="default" className="mt-2" onClick={onFetch} loading={fetching}>
            <DownloadOutlined />
            {t("modelConfig.fetchModels")}
          </Button>
        </Empty>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
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
                  className="flex h-full items-center px-2 text-xs font-medium text-muted-foreground"
                >
                  {r.label}
                </div>
              ) : (
                <ModelRow m={r.m} dim={r.dim} onToggle={onToggle} onDelete={onDelete} />
              )
            }
          />
        </div>
      )}
    </>
  );

  return (
    <Tabs
      value={filter}
      onValueChange={(value) => setFilter(value as "all" | ModelCapability)}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <TabsList className="mx-4 mt-3 grid w-auto shrink-0 grid-cols-4">
        {chips.map((chip) => (
          <TabsTrigger key={chip.key} value={chip.key}>
            {chip.label}
            <span className="text-xs tabular-nums opacity-55">{chip.count}</span>
          </TabsTrigger>
        ))}
      </TabsList>
      {chips.map((chip) => (
        <TabsContent key={chip.key} value={chip.key} className="flex min-h-0 flex-1 flex-col">
          {renderModelContent()}
        </TabsContent>
      ))}
    </Tabs>
  );
}

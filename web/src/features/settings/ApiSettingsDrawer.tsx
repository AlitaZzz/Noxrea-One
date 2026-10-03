/**
 * 模型渠道配置抽屉（API 设置）。
 * master–detail 双栏：左栏供应商轨道（选择 / 新增入口），右栏详情或表单视图。
 * 详情 = 连接信息（Base URL / 密钥掩码按需揭示）+ 模型能力管理（ApiSettingsModels）。
 * 属全局模型配置能力，与画布本身无依赖关系。
 */

"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ApiOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
} from "@/components/ui/AppIcon";
import { EyeIcon } from "@/components/ui/AppIcon";
import { EyeOffIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import ApiSettingsForm from "@/features/settings/ApiSettingsForm";
import ApiSettingsModels from "@/features/settings/ApiSettingsModels";
import { useModelStore } from "@/lib/model-store";
import type { ModelProvider } from "@/lib/types/models";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 连接信息：Base URL / API 密钥两行。密钥常态掩码，眼睛 / 复制按需拉明文。
    key 由父组件绑定 provider.id，切换供应商时状态自动重置。 */
function ConnectionInfo({ provider }: { provider: ModelProvider }) {
  const { t } = useTranslation();
  const { message } = useAppFeedback();
  const fetchProviderApiKey = useModelStore((s) => s.fetchProviderApiKey);

  const [revealed, setRevealed] = useState(false);
  const [plain, setPlain] = useState("");
  const [loading, setLoading] = useState(false);

  // 按需拉取明文；已揭示则直接返回缓存
  const ensurePlain = async (): Promise<string | null> => {
    if (revealed) return plain;
    setLoading(true);
    try {
      const key = await fetchProviderApiKey(provider.id);
      setPlain(key);
      setRevealed(true);
      return key;
    } catch {
      message.error(t("modelConfig.apiKeyFetchFailed"));
      return null;
    } finally {
      setLoading(false);
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(t("modelConfig.apiKeyCopied"));
    } catch {
      message.error(t("modelConfig.apiKeyCopyFailed"));
    }
  };

  return (
    <div className="flex flex-col gap-2 border-b border-border px-5 py-3.5">
      <div className="flex items-center gap-3">
        <span className="w-16 shrink-0 text-xs text-muted-foreground">
          {t("modelConfig.baseUrl")}
        </span>
        <span
          className="flex-1 min-w-0 truncate font-mono text-xs text-muted-foreground"
        >
          {provider.baseUrl}
        </span>
        <Button size="sm" variant="ghost" iconOnly aria-label={t("modelConfig.copy")} onClick={() => copyText(provider.baseUrl)}>
          <CopyOutlined />
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-16 shrink-0 text-xs text-muted-foreground">
          {t("modelConfig.apiKey")}
        </span>
        <span
          className="flex-1 min-w-0 truncate font-mono text-xs text-muted-foreground"
        >
          {revealed ? plain : provider.apiKey}
        </span>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          aria-label={revealed ? t("modelConfig.hide") : t("modelConfig.reveal")}
          loading={loading}
          onClick={() => {
            if (revealed) setRevealed(false);
            else ensurePlain();
          }}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          aria-label={t("modelConfig.copy")}
          onClick={async () => {
            const key = await ensurePlain();
            if (key !== null) copyText(key);
          }}
        >
          <CopyOutlined />
        </Button>
      </div>
    </div>
  );
}

export default function ApiSettingsDrawer({ open, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = useAppFeedback();
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);
  const providers = useModelStore((s) => s.providers);
  const presets = useModelStore((s) => s.presets);
  const deleteProvider = useModelStore((s) => s.deleteProvider);
  const fetchModels = useModelStore((s) => s.fetchModels);

  // Drawer 打开时阻止画布快捷键透传
  useEffect(() => {
    setModalOpen(open);
    return () => setModalOpen(false);
  }, [open, setModalOpen]);

  const [providerId, setProviderId] = useState<string | null>(null);
  const [view, setView] = useState<"detail" | "form">("detail");
  const [formMode, setFormMode] = useState<"add" | "edit">("add");
  const [fetching, setFetching] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const provider = providers.find((c) => c.id === providerId);

  // 打开时未选中则默认选第一个供应商。
  // 在渲染期调整（store previous render 模式），避免级联 effect。
  const [prevNeedProvider, setPrevNeedProvider] = useState(false);
  const needProvider = !!(open && providers.length > 0 && !providerId);
  if (needProvider !== prevNeedProvider) {
    setPrevNeedProvider(needProvider);
    if (needProvider) setProviderId(providers[0].id);
  }

  const startAdd = () => {
    setFormMode("add");
    setView("form");
  };
  const startEdit = () => {
    setFormMode("edit");
    setView("form");
  };
  const selectProvider = (id: string) => {
    setProviderId(id);
    setView("detail");
  };

  const handleFetch = async () => {
    if (!providerId) return;
    setFetching(true);
    const result = await fetchModels(providerId);
    if (result.success) {
      message.success(t("modelConfig.modelsFetched"));
    } else {
      // 失败原因由 store / fetchModels 统一提示
    }
    setFetching(false);
  };

  // 表单保存成功：新增态选中新供应商（store 末尾），回到详情
  const handleFormDone = () => {
    if (formMode === "add") {
      const latest = useModelStore.getState().providers;
      if (latest.length > 0) setProviderId(latest[latest.length - 1].id);
    }
    setView("detail");
  };

  const fetchLabel =
    provider && provider.models.length > 0
      ? `${t("modelConfig.fetchModels")} (${provider.models.length})`
      : t("modelConfig.fetchModels");

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      >
        <SheetContent
          side="right"
          className="w-[min(780px,100vw)] !max-w-[min(780px,100vw)] gap-0 border-l border-border p-0"
        >
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <ApiOutlined className="text-muted-foreground" />
              {t("modelConfig.apiSettings")}
            </SheetTitle>
            <SheetDescription>{t("modelConfig.apiSettingsDescription")}</SheetDescription>
          </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col text-foreground">
          <div className="flex flex-1 min-h-0">
          {/* ===== 左栏：供应商轨道 ===== */}
          <div
            className="flex w-[220px] shrink-0 flex-col select-none border-r border-border"
          >
            <div className="flex items-center gap-1.5 border-b border-border px-4 py-3">
              <span className="text-[13px] font-medium text-foreground">
                {t("modelConfig.providers")}
              </span>
              {providers.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {providers.length}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                className="ml-auto"
                aria-label={t("modelConfig.addProvider")}
                onClick={startAdd}
              >
                <PlusOutlined />
              </Button>
            </div>
            {providers.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center text-muted-foreground">
                <div className="text-[13px] text-muted-foreground">{t("modelConfig.noProviders")}</div>
                <Button size="sm" variant="primary" className="mt-1" onClick={startAdd}>
                  <PlusOutlined />
                  {t("modelConfig.addProvider")}
                </Button>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5">
                {providers.map((c) => {
                  const active = view === "detail" && c.id === providerId;
                  return (
                    <Button
                      key={c.id}
                      type="button"
                      variant="ghost"
                      aria-pressed={active}
                      onClick={() => selectProvider(c.id)}
                      className="relative h-auto w-full justify-start rounded-md px-3 py-2 text-left aria-pressed:bg-muted aria-pressed:text-foreground"
                    >
                      {active && (
                        <span
                          className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-ring"
                          aria-hidden="true"
                        />
                      )}
                      <div
                        className={`truncate text-[13px] ${active ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        {c.name}
                      </div>
                      {/* 「已启用/总数」分数形式：青柠分子呼应能力 pill 点亮语义，口径与右侧模型区一致 */}
                      {(() => {
                        const enabled = c.models.filter((m) => (m.capabilities?.length ?? 0) > 0).length;
                        return (
                          <div
                            className="mt-0.5 text-xs tabular-nums text-muted-foreground"
                            aria-label={t("modelConfig.enabledCount", { enabled, total: c.models.length })}
                          >
                            <span className={enabled > 0 ? "text-primary" : undefined}>{enabled}</span>
                            /{c.models.length}
                          </div>
                        );
                      })()}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ===== 右栏：详情 / 表单 ===== */}
          <div className="flex-1 min-w-0 flex flex-col">
            {view === "form" ? (
              <ApiSettingsForm
                key={`${formMode}-${formMode === "edit" ? provider?.id ?? "gone" : "new"}`}
                mode={formMode}
                provider={formMode === "edit" ? provider : undefined}
                presets={presets}
                onDone={handleFormDone}
                onCancel={() => setView("detail")}
              />
            ) : provider ? (
              <>
                {/* 详情头：名称 + 协议 + 操作 */}
                <div className="flex select-none items-center gap-2 border-b border-border px-5 py-3">
                  <span className="truncate text-[15px] font-semibold text-foreground">
                    {provider.name}
                  </span>
                  {provider.protocol && (
                    <span
                      className="shrink-0 rounded-md border border-border px-1.5 py-1 text-xs leading-none text-muted-foreground"
                    >
                      {t(`modelConfig.protocol.${provider.protocol}`)}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={handleFetch} loading={fetching}>
                      <DownloadOutlined />
                      {fetchLabel}
                    </Button>
                    <Button size="sm" variant="outline" onClick={startEdit}>
                      <EditOutlined />
                      {t("common.edit")}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>
                      <DeleteOutlined />
                      {t("common.delete")}
                    </Button>
                  </div>
                </div>
                {/* 连接信息（key 保证切供应商时揭示状态重置） */}
                <ConnectionInfo key={provider.id} provider={provider} />
                {/* 模型区 */}
                <ApiSettingsModels provider={provider} onFetch={handleFetch} fetching={fetching} />
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-1.5 text-center text-muted-foreground">
                <ApiOutlined className="text-3xl mb-1" />
                <div className="text-sm text-muted-foreground">{t("modelConfig.noProviders")}</div>
                <div className="text-xs">{t("modelConfig.noProvidersDesc")}</div>
                <Button size="sm" variant="primary" className="mt-2" onClick={startAdd}>
                  <PlusOutlined />
                  {t("modelConfig.addProvider")}
                </Button>
              </div>
            )}
          </div>
        </div>
        </div>
        </SheetContent>
      </Sheet>
      <ConfirmModal
        open={deleteOpen}
        zIndex={1050}
        title={t("modelConfig.deleteProvider")}
        content={t("modelConfig.deleteProviderConfirm", {
          name: provider?.name ?? "",
          count: provider?.models.length ?? 0,
        })}
        okText={t("common.delete")}
        cancelText={t("common.cancel")}
        confirmVariant="destructive"
        onOk={async () => {
          if (!providerId) return;
          try {
            // 删除失败时不关闭确认框、不重置选择，用户可重试
            if (await deleteProvider(providerId)) {
              const rest = useModelStore.getState().providers;
              setProviderId(rest[0]?.id ?? null);
              setDeleteOpen(false);
            }
          } catch {
            // 异常已由全局流程处理（清 token + 跳登录）
          }
        }}
        onCancel={() => setDeleteOpen(false)}
      />
    </>
  );
}

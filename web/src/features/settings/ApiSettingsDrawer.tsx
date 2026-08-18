/**
 * 模型渠道配置抽屉。
 * 管理服务商渠道（增删改、Base URL 与密钥填写）及其下模型清单，
 * 按文本 / 图像 / 视频 / 音频能力分页展示与勾选启用，供各生成面板取用。
 * 属全局模型配置能力，与画布本身无依赖关系。
 */
"use client";

import {
  ApiOutlined,
  AudioOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PictureOutlined,
  PlusOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { App, Button, Checkbox, Drawer,Input, Select } from "antd";
import type { ReactNode } from "react";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import ConfirmModal from "@/components/ui/ConfirmModal";
import { EyeIcon } from "@/components/ui/icons/common/EyeIcon";
import { EyeOffIcon } from "@/components/ui/icons/common/EyeOffIcon";
import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { VirtualList } from "@/components/ui/VirtualList";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { ModelIcon } from "@/lib/model-icon";
import { useModelStore } from "@/lib/model-store";
import type { ModelCapability, ModelInfo } from "@/lib/types/models";

interface Props {
  open: boolean;
  onClose: () => void;
}

// ── 模块级常量与组件（稳定引用，避免每次渲染重建导致虚拟列表失效） ──
const CAPABILITY_TABS: {
  key: ModelCapability;
  labelKey: string;
  icon: ReactNode;
  color: string;
}[] = [
  { key: "text", labelKey: "modelConfig.cap.text", icon: <TextIcon />, color: "#1677ff" },
  { key: "image", labelKey: "modelConfig.cap.image", icon: <PictureOutlined />, color: "#52c41a" },
  { key: "video", labelKey: "modelConfig.cap.video", icon: <VideoCameraOutlined />, color: "#13c2c2" },
  { key: "audio", labelKey: "modelConfig.cap.audio", icon: <AudioOutlined />, color: "#fa8c16" },
];

// 单行（已 memo）：仅在 m / checked / activeCap / onToggle 变化时才重渲染
const ModelRow = memo(function ModelRow({
  m,
  checked,
  activeCap,
  onToggle,
}: {
  m: ModelInfo;
  checked: boolean;
  activeCap: ModelCapability;
  onToggle: (id: string) => void;
}) {
  const color = CAPABILITY_TABS.find((t) => t.key === activeCap)?.color;
  return (
    <label
      className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-[var(--canvas-bg-hover)] text-sm transition-colors"
      style={{ color: checked ? "var(--canvas-text)" : "var(--canvas-text-dim)" }}
    >
      <Checkbox
        checked={checked}
        onChange={() => onToggle(m.id)}
        style={checked ? { accentColor: color } : undefined}
      />
      <ModelIcon model={m.name} className="text-xs flex-shrink-0" style={{ color: "var(--canvas-text-dim)" }} />
      <span className="flex-1 truncate">{m.name}</span>
    </label>
  );
});

export default function ApiSettingsDrawer({ open, onClose }: Props) {
  const { t } = useTranslation();
  const isDark = useCanvasStore((s) => s.theme) === "dark";
  const { message } = App.useApp();
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);
  const providers = useModelStore((s) => s.providers);
  const presets = useModelStore((s) => s.presets);
  const addProvider = useModelStore((s) => s.addProvider);
  const updateProvider = useModelStore((s) => s.updateProvider);
  const fetchProviderApiKey = useModelStore((s) => s.fetchProviderApiKey);
  const deleteProvider = useModelStore((s) => s.deleteProvider);
  const addModel = useModelStore((s) => s.addModel);
  const toggleModelCapability = useModelStore((s) => s.toggleModelCapability);
  const setProviderModels = useModelStore((s) => s.setProviderModels);
  const fetchModels = useModelStore((s) => s.fetchModels);

  // Drawer 打开时阻止画布快捷键透传
  useEffect(() => {
    setModalOpen(open);
    return () => setModalOpen(false);
  }, [open, setModalOpen]);

  const [providerId, setProviderId] = useState<string | null>(null);
  const [activeCap, setActiveCap] = useState<ModelCapability>("image");
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [editProviderId, setEditProviderId] = useState<string | null>(null);
  const [chForm, setChForm] = useState({ name: "", baseUrl: "", apiKey: "", protocol: "openai" });
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyRevealed, setApiKeyRevealed] = useState(false);
  const [apiKeyMasked, setApiKeyMasked] = useState("");
  const [keyDirty, setKeyDirty] = useState(false);
  const [fetchingKey, setFetchingKey] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [fetching, setFetching] = useState(false);
  const [deleteProviderId, setDeleteProviderId] = useState<string | null>(null);
  const [searchModel, setSearchModel] = useState("");

  const provider = providers.find((c) => c.id === providerId);

  // Pick the first provider when the modal opens without a selection.
  // Adjusted during render (not in an effect) to avoid cascading renders.
  // Pick the first provider when the modal opens without a selection.
  // Adjusted during render (matching the "store previous render" pattern).
  const [prevNeedProvider, setPrevNeedProvider] = useState(false);
  const needProvider = !!(open && providers.length > 0 && !providerId);
  if (needProvider !== prevNeedProvider) {
    setPrevNeedProvider(needProvider);
    if (needProvider) setProviderId(providers[0].id);
  }

  const resetChForm = () => {
    setChForm({ name: "", baseUrl: "", apiKey: "", protocol: "openai" });
    setEditProviderId(null);
    setShowAddProvider(false);
    setApiKeyVisible(false);
    setApiKeyRevealed(false);
    setApiKeyMasked("");
    setKeyDirty(false);
  };

  const handleSaveProvider = () => {
    if (!chForm.name.trim() || !chForm.baseUrl.trim()) return;
    if (editProviderId) {
      updateProvider(editProviderId, {
        name: chForm.name.trim(), baseUrl: chForm.baseUrl.trim(), protocol: chForm.protocol,
        apiKey: keyDirty && !chForm.apiKey.includes("****") ? (chForm.apiKey.trim() || undefined) : undefined,
      });
      message.success(t("modelConfig.providerUpdated"));
    } else {
      addProvider(chForm.name.trim(), chForm.baseUrl.trim(), chForm.apiKey.trim(), chForm.protocol);
      message.success(t("modelConfig.providerAdded"));
    }
    resetChForm();
  };

  const handleEditProvider = (id: string) => {
    const ch = providers.find((c) => c.id === id);
    if (!ch) return;
    // 预填掩码 apiKey：用户可见掩码值，点击小眼睛拉取明文
    setApiKeyMasked(ch.apiKey);
    setApiKeyRevealed(false);
    setKeyDirty(false);
    setApiKeyVisible(false);
    setChForm({
      name: ch.name, baseUrl: ch.baseUrl, apiKey: ch.apiKey,
      protocol: ch.protocol || "openai",
    });
    setEditProviderId(id);
    setShowAddProvider(true);
  };

  // 点击小眼睛：首次揭示时从后端拉取明文密钥
  const handleApiKeyVisibleChange = async (visible: boolean) => {
    setApiKeyVisible(visible);
    if (visible && editProviderId && !apiKeyRevealed && !keyDirty) {
      setFetchingKey(true);
      try {
        const plain = await fetchProviderApiKey(editProviderId);
        setChForm((f) => ({ ...f, apiKey: plain }));
        setApiKeyRevealed(true);
      } catch {
        message.error(t("modelConfig.apiKeyFetchFailed"));
        setApiKeyVisible(false);
      }
      setFetchingKey(false);
    }
  };

  // 复制按钮：按需拉取明文后复制到剪贴板
  const handleCopyApiKey = async () => {
    if (!editProviderId) return;
    let textToCopy = chForm.apiKey;
    if (!apiKeyRevealed && !keyDirty) {
      setFetchingKey(true);
      try {
        textToCopy = await fetchProviderApiKey(editProviderId);
        setChForm((f) => ({ ...f, apiKey: textToCopy }));
        setApiKeyRevealed(true);
        setApiKeyVisible(true);
      } catch {
        message.error(t("modelConfig.apiKeyFetchFailed"));
        setFetchingKey(false);
        return;
      }
      setFetchingKey(false);
    }
    try {
      await navigator.clipboard.writeText(textToCopy);
      message.success(t("modelConfig.apiKeyCopied"));
    } catch {
      message.error(t("modelConfig.apiKeyCopyFailed"));
    }
  };

  const handleFetch = async () => {
    if (!providerId) return;
    console.log("[UI] handleFetch called with providerId:", providerId);
    setFetching(true);
    const result = await fetchModels(providerId);
    if (result.success) {
      message.success("Models fetched");
    } else {
      message.error(result.error ?? "Failed to fetch models");
    }
    setFetching(false);
  };

  const handleAddModel = () => {
    if (!newModelName.trim() || !providerId) return;
    addModel(providerId, newModelName.trim());
    setNewModelName("");
  };

  // Models filtered by current capability tab
  const capModels = provider?.models.filter((m) => m.capabilities?.includes(activeCap)) || [];
  const otherModels = provider?.models.filter((m) => !m.capabilities?.includes(activeCap)) || [];

  // 搜索过滤（不区分大小写，空串 = 全部）
  const searchLower = searchModel.trim().toLowerCase();
  const filterFn = (m: { name: string }) => !searchLower || m.name.toLowerCase().includes(searchLower);
  const filteredCap = capModels.filter(filterFn);
  const filteredOther = otherModels.filter(filterFn);
  // 批量操作目标：当前过滤后可见的全部模型（cap + other）
  const visibleModels = [...filteredCap, ...filteredOther];

  // 批量勾选：本地算好全量 capabilities，一次 set_models 提交
  const batchApply = async (nextCapsForVisible: (m: ModelInfo) => ModelCapability[]) => {
    if (!provider || visibleModels.length === 0) return;
    const visibleIds = new Set(visibleModels.map((m) => m.id));
    const merged = provider.models.map((m) => ({
      name: m.name,
      capabilities: visibleIds.has(m.id) ? nextCapsForVisible(m) : (m.capabilities || []),
    }));
    await setProviderModels(provider.id, merged);
  };
  const batchSelectAll = () => batchApply((m) => Array.from(new Set([...(m.capabilities || []), activeCap])));
  const batchInvert = () => batchApply((m) => {
    const has = (m.capabilities || []).includes(activeCap);
    return has ? (m.capabilities || []).filter((c) => c !== activeCap) : [...(m.capabilities || []), activeCap];
  });
  const batchClear = () => batchApply((m) => (m.capabilities || []).filter((c) => c !== activeCap));

  // 切换单行能力；交给 React Compiler 自动 memo，移除手写 useCallback 以让其优化。
  const onToggleCap = (id: string) => toggleModelCapability(provider?.id ?? "", id, activeCap);

  // 合并为「已启用 / 可用」两段、带分组标题的扁平数组，交给虚拟列表渲染
  type Row =
    | { kind: "header"; key: string; label: string; tone: "cap" | "other" }
    | { kind: "model"; key: string; m: ModelInfo; checked: boolean };
  const rows: Row[] = [];
  if (filteredCap.length > 0) {
    rows.push({ kind: "header", key: "h-cap", label: t("common.enabled"), tone: "cap" });
    for (const m of filteredCap) rows.push({ kind: "model", key: m.id, m, checked: true });
  }
  if (filteredOther.length > 0) {
    rows.push({ kind: "header", key: "h-other", label: t("common.available"), tone: "other" });
    for (const m of filteredOther) rows.push({ kind: "model", key: m.id, m, checked: false });
  }

  return (
    <>
    <Drawer
      title={
        <div className="flex items-center gap-2">
          <ApiOutlined />
          <span style={{ color: "var(--canvas-text)" }}>{t("modelConfig.apiSettings")}</span>
        </div>
      }
      open={open}
      onClose={onClose}
      size={600}
      placement="right"
      closable={{ placement: "end" }}
      destroyOnHidden
      styles={{
        header: { background: "var(--canvas-bg)", borderBottom: "1px solid var(--canvas-border)", userSelect: "none" },
        body: { background: "var(--canvas-bg)", padding: 0, display: "flex", flexDirection: "column", height: "100%" },
        section: isDark ? { borderLeft: "1px solid #2c2c31" } : undefined,
      }}
    >
    <div className="model-config-wrap flex flex-col h-full overflow-y-auto select-none">
      <style>{`
        .model-config-wrap { scrollbar-width: none; -ms-overflow-style: none; }
        .model-config-wrap::-webkit-scrollbar { display: none; }
        .model-config-wrap input:not([type]), .model-config-wrap .ant-input, .model-config-wrap .ant-input-password { background: var(--canvas-bg) !important; border-color: var(--canvas-border) !important; color: var(--canvas-text) !important; border-radius: 8px !important; font-size: 13px !important; height: 36px !important; }
        .model-config-wrap textarea.ant-input { height: auto !important; padding: 8px 11px !important; }
        .model-config-wrap .ant-select.ant-select, .model-config-wrap .ant-select-selector.ant-select-selector { height: 36px !important; background: var(--canvas-bg) !important; color: var(--canvas-text) !important; }
        .model-config-wrap .ant-input-affix-wrapper { background: var(--canvas-bg) !important; border-color: var(--canvas-border) !important; border-radius: 8px !important; height: 36px !important; }
        .model-config-wrap .ant-input-affix-wrapper .ant-input { background: transparent !important; border: none !important; height: 34px !important; }
        .model-config-wrap input:not([type]):focus, .model-config-wrap .ant-input:focus, .model-config-wrap .ant-input-password:focus { border-color: var(--canvas-border) !important; box-shadow: none !important; }
        .model-config-wrap input:not([type]):hover, .model-config-wrap .ant-input:hover, .model-config-wrap .ant-input-password:hover { border-color: var(--canvas-border) !important; }
        .model-config-wrap textarea::placeholder, .model-config-wrap input::placeholder { color: var(--canvas-text-muted) !important; opacity: 1 !important; }
        .model-config-wrap .ant-input-password { display: flex !important; align-items: center !important; }
        .model-config-wrap .ant-input-password .ant-input-suffix { display: flex; align-items: center; }
        .model-config-wrap .ant-input-password input { height: 34px !important; line-height: 34px !important; padding-top: 0 !important; padding-bottom: 0 !important; }
        .model-config-wrap .ant-input-password:focus, .model-config-wrap .ant-input-password-focused, .model-config-wrap .ant-input-affix-wrapper-focused { border-color: var(--canvas-border) !important; box-shadow: none !important; outline: none !important; }
        .model-config-wrap .model-btn { background: var(--canvas-bg); border: none !important; box-shadow: none !important; color: var(--canvas-text); border-radius: 8px; height: 36px; }
        .model-config-wrap .model-btn:hover:not(:disabled) { color: var(--canvas-text) !important; background: var(--canvas-bg-hover) !important; }
        .model-config-wrap .ant-btn { background: var(--canvas-bg); border: none !important; box-shadow: none !important; color: var(--canvas-text); border-radius: 8px; height: 36px; }
        .model-config-wrap .ant-btn:hover:not(:disabled) { color: var(--canvas-text) !important; background: var(--canvas-bg-hover) !important; }
        .model-config-wrap .ant-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      `}</style>
      {/* ===== Provider selector ===== */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: "var(--canvas-border)" }}>
        <span className="text-xs flex-shrink-0" style={{ color: "var(--canvas-text-dim)" }}>{t("modelConfig.providers")}:</span>
        <Select
          size="small"
          value={providerId}
          onChange={(v) => { setProviderId(v); setActiveCap("image"); }}
          disabled={showAddProvider}
          style={{ width: 150, height: 32 }}
          options={providers.map((c) => ({ label: c.name, value: c.id }))}
          notFoundContent={<span className="text-xs" style={{ color: "var(--canvas-text-muted)" }}>{t("modelConfig.noProviders")}</span>}
        />
        <div className="flex items-center gap-1 ml-auto">
          <Button size="small" icon={<PlusOutlined />} onClick={() => { resetChForm(); setShowAddProvider(true); }} className="model-btn">
            {t("modelConfig.addProvider")}
          </Button>
          {provider && (
            <>
              <div className="w-px h-4 mx-0.5 self-center" style={{ background: "var(--canvas-border)" }} />
              <Button size="small" icon={<DownloadOutlined />} onClick={handleFetch} loading={fetching} className="model-btn">
                {provider.models.length > 0 ? `${t("modelConfig.fetchModels")} (${provider.models.length})` : t("modelConfig.fetchModels")}
              </Button>
              <Button size="small" icon={<EditOutlined />} onClick={() => handleEditProvider(provider.id)} className="model-btn">
                {t("common.edit")}
              </Button>
              <Button size="small" icon={<DeleteOutlined />} className="model-btn" onClick={() => setDeleteProviderId(provider.id)}>
                {t("common.delete")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ===== Add/Edit provider form ===== */}
      {showAddProvider && (
        <div className="px-4 py-3 flex flex-col gap-2 border-b" style={{ borderColor: "var(--canvas-border)" }}>
          <div className="flex gap-1">
            <div className="flex flex-col gap-2" style={{ flex: 1 }}>
              <div className="flex flex-col gap-0.5">
                <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("common.name")}</span>
                <Input size="small" placeholder={t("modelConfig.myApi")} value={chForm.name} onChange={(e) => setChForm((f) => ({ ...f, name: e.target.value }))} style={{ width: "100%" }} autoFocus />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("modelConfig.baseUrl")}</span>
                <Input size="small" placeholder="https://api.openai.com/v1" value={chForm.baseUrl} onChange={(e) => setChForm((f) => ({ ...f, baseUrl: e.target.value }))} style={{ width: "100%" }} />
              </div>
            </div>
            <div className="flex flex-col gap-2" style={{ flex: 1 }}>
              <div className="flex gap-1">
                <div className="flex flex-col gap-0.5" style={{ flex: 1 }}>
                  <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("modelConfig.protocolLabel")}</span>
                  <Select
                    size="small"
                    value={chForm.protocol}
                    onChange={(v) => setChForm((f) => ({ ...f, protocol: v }))}
                    style={{ width: "100%" }}
                    options={[
                      { label: t("modelConfig.protocol.openai"), value: "openai" },
                      { label: t("modelConfig.protocol.gemini"), value: "gemini" },
                      { label: t("modelConfig.protocol.ark"), value: "ark" },
                    ]}
                  />
                </div>
                <div className="flex flex-col gap-0.5" style={{ flex: 1 }}>
                  <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("modelConfig.preset")}</span>
                  <Select
                    size="small" style={{ width: "100%" }}
                    placeholder={t("modelConfig.preset")}
                    options={presets.map((p) => ({ label: p.name, value: p.name }))}
                    onChange={(name) => {
                      const p = presets.find((pr) => pr.name === name);
                      if (!p) return;
                      setChForm((f) => ({
                        ...f,
                        baseUrl: p.baseUrl ?? "",
                        protocol: p.protocol || "openai",
                      }));
                    }}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("modelConfig.apiKey")}</span>
                <div className="flex gap-1">
                  <Input.Password
                    placeholder={editProviderId ? t("modelConfig.apiKeyKeepBlank") : "sk-..."}
                    value={chForm.apiKey}
                    onChange={(e) => {
                      setChForm((f) => ({ ...f, apiKey: e.target.value }));
                      setKeyDirty(true);
                    }}
                    style={{ flex: 1 }}
                    visibilityToggle={{ visible: apiKeyVisible, onVisibleChange: handleApiKeyVisibleChange }}
                    iconRender={(v) => (v ? <EyeIcon style={{ color: "var(--canvas-text)" }} /> : <EyeOffIcon style={{ color: "var(--canvas-text)" }} />)}
                  />
                  {editProviderId && (
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={handleCopyApiKey}
                      loading={fetchingKey}
                      className="model-btn"
                      style={{ flexShrink: 0 }}
                    />
                  )}
                </div>
          </div>
          </div>
          </div>
          <div className="flex gap-1 justify-end">
            <Button size="small" onClick={resetChForm} className="model-btn text-[13px] px-4">{t("common.cancel")}</Button>
            <Button size="small" onClick={handleSaveProvider} disabled={!chForm.name.trim() || !chForm.baseUrl.trim()} style={{ height: 36, fontSize: 13 }}>
              {editProviderId ? t("auth.saveChanges") : t("modelConfig.addProvider")}
            </Button>
          </div>
        </div>
      )}

      {/* ===== Capability tabs ===== */}
      <div className="flex border-b" style={{ borderColor: "var(--canvas-border)" }}>
        {CAPABILITY_TABS.map((tab) => {
          const count = provider?.models.filter((m) => m.capabilities?.includes(tab.key)).length || 0;
          return (
            <button
              key={tab.key}
              className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 border-transparent"
              style={{
                background: "transparent", cursor: "pointer",
                color: activeCap === tab.key ? tab.color : "var(--canvas-text-dim)",
                borderColor: activeCap === tab.key ? tab.color : "transparent",
              }}
              onClick={() => setActiveCap(tab.key)}
            >
              {tab.icon}
              {t(tab.labelKey)}
              <span className="text-[12px] opacity-60">({count})</span>
            </button>
          );
        })}
      </div>

      {/* ===== Model list ===== */}
      <div className="p-5 flex-1 flex flex-col min-h-[300px] overflow-hidden" style={{ scrollbarGutter: "stable" }}>
        {!provider ? (
          <div className="text-center py-12" style={{ color: "var(--canvas-text-muted)" }}>
            <ApiOutlined className="text-3xl mb-2 block" />
            {t("modelConfig.noProvidersDesc")}
          </div>
        ) : provider.models.length === 0 ? (
          <div className="text-center py-8" style={{ color: "var(--canvas-text-muted)" }}>
            <div className="text-sm mb-1">{t("modelConfig.noModels")}</div>
            <div className="text-xs mb-3">{t("modelConfig.noModelsDesc")}</div>
          </div>
        ) : (
          <>
            {/* Search + batch ops */}
            <div className="flex items-center gap-1.5 mb-3 flex-shrink-0">
              <Input
                size="small"
                allowClear
                placeholder={t("modelConfig.searchModel")}
                value={searchModel}
                onChange={(e) => setSearchModel(e.target.value)}
                style={{ flex: 1 }}
              />
              <Button size="small" className="model-btn" onClick={batchSelectAll} disabled={visibleModels.length === 0}>{t("modelConfig.selectAll") || "全选"}</Button>
              <Button size="small" className="model-btn" onClick={batchInvert} disabled={visibleModels.length === 0}>{t("modelConfig.invert") || "反选"}</Button>
              <Button size="small" className="model-btn" onClick={batchClear} disabled={filteredCap.length === 0}>{t("modelConfig.clearCap") || "清空"}</Button>
            </div>

            {/* Add model manually */}
            <div className="flex gap-1.5 mb-3 flex-shrink-0">
              <Input
                size="small"
                placeholder={t("modelConfig.addModelPlaceholder")}
                value={newModelName}
                onChange={(e) => setNewModelName(e.target.value)}
                onPressEnter={handleAddModel}
                style={{ flex: 1 }}
              />
              <Button size="small" icon={<PlusOutlined />} onClick={handleAddModel} disabled={!newModelName.trim()} className="model-btn">
                {t("common.add")}
              </Button>
            </div>

            {/* 虚拟列表：仅渲染可视区行；搜索已在数据层完成（rows 已是过滤后结果），不影响搜得到 */}
            <VirtualList
              items={rows}
              itemHeight={36}
              rowKey={(r) => r.key}
              className="flex-1 min-h-0"
              style={{ scrollbarGutter: "stable" }}
              renderItem={(r) =>
                r.kind === "header" ? (
                  <div
                    className="flex items-center gap-1 text-[12px] font-medium"
                    style={{
                      height: 36,
                      color:
                        r.tone === "cap"
                          ? CAPABILITY_TABS.find((t) => t.key === activeCap)?.color
                          : "var(--canvas-text-muted)",
                    }}
                  >
                    {r.tone === "cap" && CAPABILITY_TABS.find((t) => t.key === activeCap)?.icon}
                    {r.label}
                  </div>
                ) : (
                  <ModelRow m={r.m} checked={r.checked} activeCap={activeCap} onToggle={onToggleCap} />
                )
              }
            />
          </>
        )}

      </div>
    </div>
    </Drawer>
      <ConfirmModal
        open={!!deleteProviderId}
        title={t("modelConfig.deleteProvider")}
        content={providers.find(c => c.id === deleteProviderId)?.name || ""}
        onOk={() => { if (deleteProviderId) deleteProvider(deleteProviderId); setProviderId(null); setDeleteProviderId(null); }}
        onCancel={() => setDeleteProviderId(null)}
      />
    </>
  );
}

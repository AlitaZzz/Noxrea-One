"use client";

import { useState, useEffect } from "react";
import { Input, Button, App, Tooltip, Checkbox, Select, Drawer } from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ApiOutlined,
  RobotOutlined,
  EditOutlined,
  PictureOutlined,
  FontSizeOutlined,
  VideoCameraOutlined,
  AudioOutlined,
} from "@ant-design/icons";
import { useModelStore } from "@/stores/model-store";
import type { ModelCapability, ModelInfo } from "@/lib/types";
import { useI18nStore } from "@/stores/i18n-store";
import ConfirmModal from "@/components/common/ConfirmModal";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ModelConfigModal({ open, onClose }: Props) {
  const t = useI18nStore((s) => s.t);
  const { message } = App.useApp();
  const CAPABILITY_TABS = [
    { key: "text" as ModelCapability, label: t("text.cap"), icon: <FontSizeOutlined />, color: "#1677ff" },
    { key: "image" as ModelCapability, label: t("image.cap"), icon: <PictureOutlined />, color: "#52c41a" },
    { key: "video" as ModelCapability, label: t("video.cap"), icon: <VideoCameraOutlined />, color: "#13c2c2" },
    { key: "audio" as ModelCapability, label: t("audio.cap"), icon: <AudioOutlined />, color: "#fa8c16" },
  ];
  const channels = useModelStore((s) => s.channels);
  const presets = useModelStore((s) => s.presets);
  const addChannel = useModelStore((s) => s.addChannel);
  const updateChannel = useModelStore((s) => s.updateChannel);
  const deleteChannel = useModelStore((s) => s.deleteChannel);
  const addModel = useModelStore((s) => s.addModel);
  const toggleModelCapability = useModelStore((s) => s.toggleModelCapability);
  const setChannelModels = useModelStore((s) => s.setChannelModels);
  const fetchModels = useModelStore((s) => s.fetchModels);

  const [channelId, setChannelId] = useState<string | null>(null);
  const [activeCap, setActiveCap] = useState<ModelCapability>("image");
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [editChannelId, setEditChannelId] = useState<string | null>(null);
  const [chForm, setChForm] = useState({ name: "", baseUrl: "", apiKey: "" });
  const [newModelName, setNewModelName] = useState("");
  const [fetching, setFetching] = useState(false);
  const [deleteChannelId, setDeleteChannelId] = useState<string | null>(null);
  const [searchModel, setSearchModel] = useState("");

  const channel = channels.find((c) => c.id === channelId);

  useEffect(() => {
    if (open && channels.length > 0 && !channelId) {
      setChannelId(channels[0].id);
    }
  }, [open, channels, channelId]);

  const resetChForm = () => {
    setChForm({ name: "", baseUrl: "", apiKey: "" });
    setEditChannelId(null);
    setShowAddChannel(false);
  };

  const handleSaveChannel = () => {
    if (!chForm.name.trim() || !chForm.baseUrl.trim()) return;
    if (editChannelId) {
      updateChannel(editChannelId, { name: chForm.name.trim(), baseUrl: chForm.baseUrl.trim(), apiKey: chForm.apiKey.trim() });
      message.success("Channel updated");
    } else {
      addChannel(chForm.name.trim(), chForm.baseUrl.trim(), chForm.apiKey.trim());
      message.success("Channel added");
    }
    resetChForm();
  };

  const handleEditChannel = (id: string) => {
    const ch = channels.find((c) => c.id === id);
    if (!ch) return;
    // apiKey 不预填（后端返回的是掩码）：留空表示保持原 key 不变，用户需改时重新输入完整值
    setChForm({ name: ch.name, baseUrl: ch.baseUrl, apiKey: "" });
    setEditChannelId(id);
    setShowAddChannel(true);
  };

  const handleFetch = async () => {
    if (!channelId) return;
    setFetching(true);
    try {
      await fetchModels(channelId);
      message.success("Models fetched");
    } catch {
      message.error("Failed to fetch models");
    }
    setFetching(false);
  };

  const handleAddModel = () => {
    if (!newModelName.trim() || !channelId) return;
    addModel(channelId, newModelName.trim());
    setNewModelName("");
  };


  // Models filtered by current capability tab
  const capModels = channel?.models.filter((m) => m.capabilities?.includes(activeCap)) || [];
  const otherModels = channel?.models.filter((m) => !m.capabilities?.includes(activeCap)) || [];

  // 搜索过滤（不区分大小写，空串 = 全部）
  const searchLower = searchModel.trim().toLowerCase();
  const filterFn = (m: { name: string }) => !searchLower || m.name.toLowerCase().includes(searchLower);
  const filteredCap = capModels.filter(filterFn);
  const filteredOther = otherModels.filter(filterFn);
  // 批量操作目标：当前过滤后可见的全部模型（cap + other）
  const visibleModels = [...filteredCap, ...filteredOther];

  // 批量勾选：本地算好全量 capabilities，一次 set_models 提交
  const batchApply = async (nextCapsForVisible: (m: ModelInfo) => ModelCapability[]) => {
    if (!channel || visibleModels.length === 0) return;
    const visibleIds = new Set(visibleModels.map((m) => m.id));
    const merged = channel.models.map((m) => ({
      name: m.name,
      capabilities: visibleIds.has(m.id) ? nextCapsForVisible(m) : (m.capabilities || []),
    }));
    await setChannelModels(channel.id, merged);
  };
  const batchSelectAll = () => batchApply((m) => Array.from(new Set([...(m.capabilities || []), activeCap])));
  const batchInvert = () => batchApply((m) => {
    const has = (m.capabilities || []).includes(activeCap);
    return has ? (m.capabilities || []).filter((c) => c !== activeCap) : [...(m.capabilities || []), activeCap];
  });
  const batchClear = () => batchApply((m) => (m.capabilities || []).filter((c) => c !== activeCap));

  return (
    <>
    <Drawer
      title={
        <div className="flex items-center gap-2">
          <ApiOutlined />
          <span style={{ color: "var(--canvas-text)" }}>{t("settings")}</span>
        </div>
      }
      open={open}
      onClose={onClose}
      size={600}
      placement="right"
      destroyOnClose
      styles={{
        header: { background: "var(--canvas-bg)", borderBottom: "1px solid var(--canvas-border)" },
        body: { background: "var(--canvas-bg)", padding: 0, display: "flex", flexDirection: "column", height: "100%" },
      }}
    >
    <div className="model-config-wrap flex flex-col h-full">
      <style>{`
        .model-config-wrap input:not([type]), .model-config-wrap .ant-input, .model-config-wrap .ant-input-password, .model-config-wrap .ant-select-selector { background: var(--canvas-bg) !important; border-color: var(--canvas-border) !important; color: var(--canvas-text) !important; border-radius: 8px !important; font-size: 13px !important; height: 36px !important; }
        .model-config-wrap .ant-input-affix-wrapper { background: var(--canvas-bg) !important; border-color: var(--canvas-border) !important; border-radius: 8px !important; height: 36px !important; }
        .model-config-wrap .ant-input-affix-wrapper .ant-input { background: transparent !important; border: none !important; height: 34px !important; }
        .model-config-wrap input:not([type]):focus, .model-config-wrap .ant-input:focus, .model-config-wrap .ant-input-password:focus, .model-config-wrap .ant-select-focused .ant-select-selector { border-color: var(--canvas-border) !important; box-shadow: none !important; }
        .model-config-wrap input:not([type]):hover, .model-config-wrap .ant-input:hover, .model-config-wrap .ant-input-password:hover, .model-config-wrap .ant-select-selector:hover { border-color: var(--canvas-border) !important; }
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
      {/* ===== Channel selector ===== */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: "var(--canvas-border)" }}>
        <span className="text-xs flex-shrink-0" style={{ color: "var(--canvas-text-dim)" }}>{t("channels")}:</span>
        <Select
          size="small"
          value={channelId}
          onChange={(v) => { setChannelId(v); setActiveCap("image"); }}
          style={{ width: 150, height: 32 }}
          options={channels.map((c) => ({ label: c.name, value: c.id }))}
          notFoundContent={<span className="text-xs" style={{ color: "var(--canvas-text-muted)" }}>{t("no.channels")}</span>}
        />
        <div className="flex items-center gap-1 ml-auto">
          <Button size="small" icon={<PlusOutlined />} onClick={() => { resetChForm(); setShowAddChannel(true); }} className="model-btn">
            {t("add.channel")}
          </Button>
          {channel && (
            <>
              <div className="w-px h-4 mx-0.5 self-center" style={{ background: "var(--canvas-border)" }} />
              <Button size="small" icon={<DownloadOutlined />} onClick={handleFetch} loading={fetching} className="model-btn">
                {channel.models.length > 0 ? `${t("fetch.models")} (${channel.models.length})` : t("fetch.models")}
              </Button>
              <Button size="small" icon={<EditOutlined />} onClick={() => handleEditChannel(channel.id)} className="model-btn">
                {t("edit")}
              </Button>
              <Button size="small" icon={<DeleteOutlined />} className="model-btn" onClick={() => setDeleteChannelId(channel.id)}>
                {t("delete")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ===== Add/Edit channel form ===== */}
      {showAddChannel && (
        <div className="px-4 py-3 flex flex-col gap-2 border-b" style={{ borderColor: "var(--canvas-border)" }}>
          <div className="flex flex-col gap-0.5">
            <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("name")}</span>
            <Input size="small" placeholder={t("my.api")} value={chForm.name} onChange={(e) => setChForm((f) => ({ ...f, name: e.target.value }))} style={{ width: "100%" }} autoFocus />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("base.url")}</span>
            <div className="flex gap-1">
              <Input size="small" placeholder="https://api.openai.com/v1" value={chForm.baseUrl} onChange={(e) => setChForm((f) => ({ ...f, baseUrl: e.target.value }))} style={{ flex: 1 }} />
              <Select
                  size="small" style={{ width: 110 }}
                  placeholder={t("preset")}
                  options={presets.map((p) => ({ label: p.name, value: p.baseUrl }))}
                  onChange={(url) => setChForm((f) => ({ ...f, baseUrl: url }))}
                />
              </div>
            </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("api.key")}</span>
            <Input.Password
              placeholder={editChannelId ? t("api.key.keepblank") : "sk-..."} value={chForm.apiKey}
              onChange={(e) => setChForm((f) => ({ ...f, apiKey: e.target.value }))}
              style={{ width: "100%" }}
              iconRender={(v) => (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--canvas-text)" }}>
                  {v ? (
                    <>
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  ) : (
                    <>
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </>
                  )}
                </svg>
              )}
            />
          </div>
          <div className="flex gap-1 justify-end">
            <Button size="small" onClick={resetChForm} className="model-btn text-[13px] px-4">{t("cancel")}</Button>
            <Button size="small" onClick={handleSaveChannel} disabled={!chForm.name.trim() || !chForm.baseUrl.trim()} style={{ height: 36, fontSize: 13 }}>
              {editChannelId ? t("save.changes") : t("add.channel")}
            </Button>
          </div>
        </div>
      )}

      {/* ===== Capability tabs ===== */}
      <div className="flex border-b" style={{ borderColor: "var(--canvas-border)" }}>
        {CAPABILITY_TABS.map((tab) => {
          const count = channel?.models.filter((m) => m.capabilities?.includes(tab.key)).length || 0;
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
              {tab.label}
              <span className="text-[12px] opacity-60">({count})</span>
            </button>
          );
        })}
      </div>

      {/* ===== Model list ===== */}
      <div className="p-5 overflow-auto flex-1" style={{ scrollbarGutter: "stable" }}>
        {!channel ? (
          <div className="text-center py-12" style={{ color: "var(--canvas-text-muted)" }}>
            <ApiOutlined className="text-3xl mb-2 block" />
            {t("no.channels.desc")}
          </div>
        ) : channel.models.length === 0 ? (
          <div className="text-center py-8" style={{ color: "var(--canvas-text-muted)" }}>
            <div className="text-sm mb-1">{t("no.models")}</div>
            <div className="text-xs mb-3">{t("no.models.desc")}</div>
          </div>
        ) : (
          <>
            {/* Search + batch ops */}
            <div className="flex items-center gap-1.5 mb-3 sticky top-0 z-10" style={{ background: "var(--canvas-bg)" }}>
              <Input
                size="small"
                allowClear
                placeholder={t("search.model")}
                value={searchModel}
                onChange={(e) => setSearchModel(e.target.value)}
                style={{ flex: 1 }}
              />
              <Button size="small" className="model-btn" onClick={batchSelectAll} disabled={visibleModels.length === 0}>{t("select.all") || "全选"}</Button>
              <Button size="small" className="model-btn" onClick={batchInvert} disabled={visibleModels.length === 0}>{t("invert") || "反选"}</Button>
              <Button size="small" className="model-btn" onClick={batchClear} disabled={filteredCap.length === 0}>{t("clear.cap") || "清空"}</Button>
            </div>

            {/* Add model manually */}
            {channel && (
              <div className="flex gap-1.5 mb-3">
                <Input
                  size="small"
                  placeholder={t("add.model.placeholder")}
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                  onPressEnter={handleAddModel}
                  style={{ flex: 1 }}
                />
                <Button size="small" icon={<PlusOutlined />} onClick={handleAddModel} disabled={!newModelName.trim()} className="model-btn">
                  {t("add")}
                </Button>
              </div>
            )}

            {/* Enabled models for this capability */}
            {filteredCap.length > 0 && (
              <div className="flex flex-col gap-1 mb-3">
                <div className="text-[12px] font-medium mb-1 flex items-center gap-1" style={{ color: CAPABILITY_TABS.find((t) => t.key === activeCap)?.color }}>
                  {CAPABILITY_TABS.find((t) => t.key === activeCap)?.icon} {t("enabled")}
                </div>
                {filteredCap.map((m) => (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 px-3 py-2 rounded cursor-pointer hover:bg-[var(--canvas-bg-hover)] text-sm transition-colors"
                    style={{ color: "var(--canvas-text)" }}
                  >
                    <Checkbox
                      checked
                      onChange={() => toggleModelCapability(channel.id, m.id, activeCap)}
                      style={{ accentColor: CAPABILITY_TABS.find((t) => t.key === activeCap)?.color }}
                    />
                    <RobotOutlined className="text-xs flex-shrink-0" style={{ color: "var(--canvas-text-dim)" }} />
                    <span className="flex-1 truncate">{m.name}</span>
                    {m.capabilities.length > 1 && (
                      <span className="flex gap-1 flex-shrink-0 items-center">
                        {m.capabilities.filter((c) => c !== activeCap).map((c) => {
                          const tab = CAPABILITY_TABS.find((t) => t.key === c);
                          return (
                            <Tooltip key={c} title={tab?.label || c}>
                              <span style={{ color: tab?.color || "#888", display: "inline-flex", alignItems: "center" }}>
                                {tab?.icon}
                              </span>
                            </Tooltip>
                          );
                        })}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}

            {/* Other models (not yet enabled for this capability) */}
            {filteredOther.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-[12px] font-medium mb-1" style={{ color: "var(--canvas-text-muted)" }}>{t("available")}</div>
                {filteredOther.map((m) => (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-[var(--canvas-bg-hover)] text-sm transition-colors"
                    style={{ color: "var(--canvas-text-dim)" }}
                  >
                    <Checkbox
                      checked={false}
                      onChange={() => toggleModelCapability(channel.id, m.id, activeCap)}
                    />
                    <RobotOutlined className="text-xs flex-shrink-0" />
                    <span className="flex-1 truncate">{m.name}</span>
                    {m.capabilities.length > 0 && (
                      <span className="flex gap-1 flex-shrink-0 items-center">
                        {m.capabilities.map((c) => {
                          const tab = CAPABILITY_TABS.find((t) => t.key === c);
                          return (
                            <Tooltip key={c} title={tab?.label || c}>
                              <span style={{ color: tab?.color || "#888", display: "inline-flex", alignItems: "center" }}>
                                {tab?.icon}
                              </span>
                            </Tooltip>
                          );
                        })}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </>
        )}

      </div>
    </div>
    </Drawer>
      <ConfirmModal
        open={!!deleteChannelId}
        title={t("delete.channel")}
        content={channels.find(c => c.id === deleteChannelId)?.name || ""}
        onOk={() => { if (deleteChannelId) deleteChannel(deleteChannelId); setChannelId(null); setDeleteChannelId(null); }}
        onCancel={() => setDeleteChannelId(null)}
      />
    </>
  );
}

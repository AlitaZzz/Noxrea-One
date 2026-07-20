"use client";

import { useState, useEffect } from "react";
import { Input, Button, App, Tag, Tooltip, Checkbox, Select } from "antd";
import AppModal from "@/lib/app-modal";
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
import type { ModelCapability } from "@/lib/types";
import { useI18nStore } from "@/stores/i18n-store";
import ConfirmModal from "@/components/common/ConfirmModal";

const PROVIDER_PRESETS = [
  { name: "OpenAI", url: "https://api.openai.com" },
  { name: "Groq", url: "https://api.groq.com/openai" },
  { name: "Together", url: "https://api.together.xyz" },
  { name: "DeepSeek", url: "https://api.deepseek.com" },
  { name: "OpenRouter", url: "https://openrouter.ai/api" },
];

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
  const addChannel = useModelStore((s) => s.addChannel);
  const updateChannel = useModelStore((s) => s.updateChannel);
  const deleteChannel = useModelStore((s) => s.deleteChannel);
  const addModel = useModelStore((s) => s.addModel);
  const toggleModelCapability = useModelStore((s) => s.toggleModelCapability);
  const fetchModels = useModelStore((s) => s.fetchModels);

  const [channelId, setChannelId] = useState<string | null>(null);
  const [activeCap, setActiveCap] = useState<ModelCapability>("image");
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [editChannelId, setEditChannelId] = useState<string | null>(null);
  const [chForm, setChForm] = useState({ name: "", baseUrl: "", apiKey: "" });
  const [newModelName, setNewModelName] = useState("");
  const [fetching, setFetching] = useState(false);
  const [deleteChannelId, setDeleteChannelId] = useState<string | null>(null);

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
    setChForm({ name: ch.name, baseUrl: ch.baseUrl, apiKey: ch.apiKey });
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

  return (
    <AppModal
      title={
        <div className="flex items-center gap-2">
          <ApiOutlined />
          <span style={{ color: "var(--canvas-text)" }}>{t("settings")}</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={1000}
      centered
      destroyOnHidden
      styles={{
        header: { background: "var(--canvas-bg)" },
        body: { background: "var(--canvas-bg)", padding: 0 },
      }}
    >
    <div className="model-config-wrap">
      <style>{`
        .model-config-wrap input:not([type]), .model-config-wrap .ant-input, .model-config-wrap .ant-input-password, .model-config-wrap .ant-select-selector { background: var(--canvas-bg) !important; border-color: var(--canvas-border) !important; color: var(--canvas-text) !important; border-radius: 8px !important; font-size: 13px !important; height: 36px !important; }
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
      <div className="flex items-center gap-2 px-5 py-2.5">
        <span className="text-xs flex-shrink-0" style={{ color: "var(--canvas-text-dim)" }}>{t("channels")}:</span>
        <Select
          size="small"
          value={channelId}
          onChange={(v) => { setChannelId(v); setActiveCap("image"); }}
          style={{ width: 180, height: 36 }}
          options={channels.map((c) => ({ label: c.name, value: c.id }))}
          notFoundContent={<span className="text-xs" style={{ color: "var(--canvas-text-muted)" }}>{t("no.channels")}</span>}
        />
        {channel && (
          <span className="text-xs truncate flex-1 min-w-0" style={{ color: "var(--canvas-text-muted)" }}>
            {channel.baseUrl}
          </span>
        )}
        <div className="flex gap-1 flex-shrink-0">
          <Button size="small" icon={<PlusOutlined />} onClick={() => { resetChForm(); setShowAddChannel(true); }} className="model-btn">
            {t("add.channel")}
          </Button>
          {channel && (
            <>
              <div className="w-px h-5 mx-0.5 self-center" style={{ background: "var(--canvas-border)" }} />
              <Button size="small" icon={<DownloadOutlined />} onClick={handleFetch} loading={fetching} className="model-btn">
                {channel.models.length > 0 ? `${t("fetch.models")} (${channel.models.length})` : t("fetch.models")}
              </Button>
              <Tooltip title={t("settings")}>
                <Button size="small" icon={<EditOutlined />} onClick={() => handleEditChannel(channel.id)} className="model-btn" />
              </Tooltip>
              <Button size="small" icon={<DeleteOutlined />} className="model-btn" onClick={() => setDeleteChannelId(channel.id)} />
            </>
          )}
        </div>
      </div>

      {/* ===== Add/Edit channel form ===== */}
      {showAddChannel && (
        <div className="px-5 py-3 flex flex-wrap gap-2 items-end border-b" style={{ borderColor: "var(--canvas-border)" }}>
          <div className="flex flex-wrap gap-2 items-end flex-1">
            <div className="flex flex-col gap-0.5" style={{ minWidth: 100 }}>
              <span className="text-[13px]" style={{ color: "var(--canvas-text-muted)" }}>{t("name")}</span>
              <Input size="small" placeholder={t("my.api")} value={chForm.name} onChange={(e) => setChForm((f) => ({ ...f, name: e.target.value }))} style={{ width: 120 }} autoFocus />
            </div>
            <div className="flex flex-col gap-0.5 flex-1" style={{ minWidth: 200 }}>
              <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("base.url")}</span>
              <div className="flex gap-1">
                <Input size="small" placeholder="https://api.openai.com" value={chForm.baseUrl} onChange={(e) => setChForm((f) => ({ ...f, baseUrl: e.target.value }))} style={{ flex: 1 }} />
                <Select
                  size="small" style={{ width: 110 }}
                  placeholder={t("preset")}
                  options={PROVIDER_PRESETS.map((p) => ({ label: p.name, value: p.url }))}
                  onChange={(url) => setChForm((f) => ({ ...f, baseUrl: url, name: f.name || PROVIDER_PRESETS.find((p) => p.url === url)?.name || "" }))}
                        />
              </div>
            </div>
            <div className="flex flex-col gap-0.5" style={{ minWidth: 160 }}>
              <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("api.key")}</span>
              <Input.Password
                placeholder="sk-..." value={chForm.apiKey}
                onChange={(e) => setChForm((f) => ({ ...f, apiKey: e.target.value }))}
                style={{}}
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
          </div>
          <div className="flex gap-1 flex-shrink-0">
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
      <div className="p-5 overflow-auto" style={{ maxHeight: "calc(100vh - 100px)" }}>
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
            {/* Enabled models for this capability */}
            {capModels.length > 0 && (
              <div className="flex flex-col gap-1 mb-3">
                <div className="text-[12px] font-medium mb-1 flex items-center gap-1" style={{ color: CAPABILITY_TABS.find((t) => t.key === activeCap)?.color }}>
                  {CAPABILITY_TABS.find((t) => t.key === activeCap)?.icon} {t("enabled")}
                </div>
                {capModels.map((m) => (
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
                      <span className="flex gap-0.5 flex-shrink-0">
                        {m.capabilities.filter((c) => c !== activeCap).map((c) => (
                          <Tag key={c} color={CAPABILITY_TABS.find((t) => t.key === c)?.color} className="text-xs leading-none" style={{ margin: 0, padding: "0 4px", lineHeight: "16px" }}>
                            {c}
                          </Tag>
                        ))}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}

            {/* Other models (not yet enabled for this capability) */}
            {otherModels.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-[12px] font-medium mb-1" style={{ color: "var(--canvas-text-muted)" }}>{t("available")}</div>
                {otherModels.map((m) => (
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
                      <span className="flex gap-0.5 flex-shrink-0">
                        {m.capabilities.map((c) => (
                          <Tag key={c} color={CAPABILITY_TABS.find((t) => t.key === c)?.color} className="text-xs leading-none" style={{ margin: 0, padding: "0 4px", lineHeight: "16px" }}>
                            {c}
                          </Tag>
                        ))}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </>
        )}

        {/* Add model manually */}
        {channel && (
          <div className="flex gap-1.5 mt-3 pt-3" style={{ borderTop: "1px solid var(--canvas-border)" }}>
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
      </div>
    </div>
      <ConfirmModal
        open={!!deleteChannelId}
        title={t("delete.channel")}
        content={channels.find(c => c.id === deleteChannelId)?.name || ""}
        onOk={() => { if (deleteChannelId) deleteChannel(deleteChannelId); setChannelId(null); setDeleteChannelId(null); }}
        onCancel={() => setDeleteChannelId(null)}
      />
    </AppModal>
  );
}

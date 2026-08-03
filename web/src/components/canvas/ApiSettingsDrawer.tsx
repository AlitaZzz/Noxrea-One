"use client";

import {
  ApiOutlined,
  AudioOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PictureOutlined,
  PlusOutlined,
  RobotOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { App, Button, Checkbox, Drawer,Input, Select } from "antd";
import type { CSSProperties,Key, ReactNode } from "react";
import { memo, useEffect, useRef, useState } from "react";

import ConfirmModal from "@/components/common/ConfirmModal";
import { TextIcon } from "@/components/common/icons/TextIcon";
import { EyeIcon } from "@/components/common/icons/EyeIcon";
import { EyeOffIcon } from "@/components/common/icons/EyeOffIcon";
import type { ModelCapability, ModelInfo } from "@/lib/types";
import { useI18nStore } from "@/stores/i18n-store";
import { useModelStore } from "@/stores/model-store";
import { useCanvasStore } from "@/stores/canvas-store";

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
  { key: "text", labelKey: "text.cap", icon: <TextIcon />, color: "#1677ff" },
  { key: "image", labelKey: "image.cap", icon: <PictureOutlined />, color: "#52c41a" },
  { key: "video", labelKey: "video.cap", icon: <VideoCameraOutlined />, color: "#13c2c2" },
  { key: "audio", labelKey: "audio.cap", icon: <AudioOutlined />, color: "#fa8c16" },
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
      <RobotOutlined className="text-xs flex-shrink-0" style={{ color: "var(--canvas-text-dim)" }} />
      <span className="flex-1 truncate">{m.name}</span>
    </label>
  );
});

// 轻量虚拟列表（固定行高，无第三方依赖）：仅渲染可视区行
const OVERSCAN = 6;
function VirtualList<T>({
  items,
  itemHeight,
  rowKey,
  renderItem,
  className,
  style,
}: {
  items: T[];
  itemHeight: number;
  rowKey: (item: T, index: number) => Key;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setViewport(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = items.length * itemHeight;
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - OVERSCAN);
  const visibleCount = Math.ceil(viewport / itemHeight) + OVERSCAN * 2;
  const end = Math.min(items.length, start + visibleCount);
  const slice = items.slice(start, end);

  return (
    <div
      ref={ref}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className={className}
      style={{ overflowY: "auto", position: "relative", ...style }}
    >
      <div style={{ height: total, position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${start * itemHeight}px)`,
          }}
        >
          {slice.map((item, i) => (
            <div key={rowKey(item, start + i)} style={{ height: itemHeight }}>
              {renderItem(item, start + i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ApiSettingsDrawer({ open, onClose }: Props) {
  const t = useI18nStore((s) => s.t);
  const isDark = useCanvasStore((s) => s.theme) === "dark";
  const { message } = App.useApp();
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);
  const channels = useModelStore((s) => s.channels);
  const presets = useModelStore((s) => s.presets);
  const addChannel = useModelStore((s) => s.addChannel);
  const updateChannel = useModelStore((s) => s.updateChannel);
  const deleteChannel = useModelStore((s) => s.deleteChannel);
  const addModel = useModelStore((s) => s.addModel);
  const toggleModelCapability = useModelStore((s) => s.toggleModelCapability);
  const setChannelModels = useModelStore((s) => s.setChannelModels);
  const fetchModels = useModelStore((s) => s.fetchModels);

  // Drawer 打开时阻止画布快捷键透传
  useEffect(() => {
    setModalOpen(open);
    return () => setModalOpen(false);
  }, [open, setModalOpen]);

  const [channelId, setChannelId] = useState<string | null>(null);
  const [activeCap, setActiveCap] = useState<ModelCapability>("image");
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [editChannelId, setEditChannelId] = useState<string | null>(null);
  const [chForm, setChForm] = useState({ name: "", baseUrl: "", apiKey: "", protocol: "openai", config: "" });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [fetching, setFetching] = useState(false);
  const [deleteChannelId, setDeleteChannelId] = useState<string | null>(null);
  const [searchModel, setSearchModel] = useState("");

  const channel = channels.find((c) => c.id === channelId);

  // Pick the first channel when the modal opens without a selection.
  // Adjusted during render (not in an effect) to avoid cascading renders.
  // Pick the first channel when the modal opens without a selection.
  // Adjusted during render (matching the "store previous render" pattern).
  const [prevNeedChannel, setPrevNeedChannel] = useState(false);
  const needChannel = !!(open && channels.length > 0 && !channelId);
  if (needChannel !== prevNeedChannel) {
    setPrevNeedChannel(needChannel);
    if (needChannel) setChannelId(channels[0].id);
  }

  const resetChForm = () => {
    setChForm({ name: "", baseUrl: "", apiKey: "", protocol: "openai", config: "" });
    setShowAdvanced(false);
    setEditChannelId(null);
    setShowAddChannel(false);
  };

  const handleSaveChannel = () => {
    if (!chForm.name.trim() || !chForm.baseUrl.trim()) return;
    // 校验高级设置 JSON 合法性
    let configObj: Record<string, unknown> | undefined = undefined;
    if (chForm.config.trim()) {
      try {
        const parsed = JSON.parse(chForm.config);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          message.error(t("modelConfig.configMustBeObject"));
          return;
        }
        configObj = parsed as Record<string, unknown>;
      } catch {
        message.error(t("modelConfig.configJsonInvalid"));
        return;
      }
    }
    if (editChannelId) {
      updateChannel(editChannelId, {
        name: chForm.name.trim(), baseUrl: chForm.baseUrl.trim(), protocol: chForm.protocol,
        apiKey: chForm.apiKey.trim() || undefined,
        config: configObj,
      });
      message.success(t("modelConfig.channelUpdated"));
    } else {
      addChannel(chForm.name.trim(), chForm.baseUrl.trim(), chForm.apiKey.trim(), chForm.protocol, configObj);
      message.success(t("modelConfig.channelAdded"));
    }
    resetChForm();
  };

  const handleEditChannel = (id: string) => {
    const ch = channels.find((c) => c.id === id);
    if (!ch) return;
    // apiKey 不预填（后端返回的是掩码）：留空表示保持原 key 不变，用户需改时重新输入完整值
    const fmt = (v: unknown) => (v && typeof v === "object" ? JSON.stringify(v, null, 2) : "");
    setChForm({ 
      name: ch.name, baseUrl: ch.baseUrl, apiKey: "",
      protocol: ch.protocol || "openai",
      config: fmt(ch.config),
    });
    setEditChannelId(id);
    setShowAddChannel(true);
  };

  const handleFetch = async () => {
    if (!channelId) return;
    console.log("[UI] handleFetch called with channelId:", channelId);
    setFetching(true);
    const result = await fetchModels(channelId);
    if (result.success) {
      message.success("Models fetched");
    } else {
      message.error(result.error ?? "Failed to fetch models");
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

  // 切换单行能力；交给 React Compiler 自动 memo，移除手写 useCallback 以让其优化。
  const onToggleCap = (id: string) => toggleModelCapability(channel?.id ?? "", id, activeCap);

  // 合并为「已启用 / 可用」两段、带分组标题的扁平数组，交给虚拟列表渲染
  type Row =
    | { kind: "header"; key: string; label: string; tone: "cap" | "other" }
    | { kind: "model"; key: string; m: ModelInfo; checked: boolean };
  const rows: Row[] = [];
  if (filteredCap.length > 0) {
    rows.push({ kind: "header", key: "h-cap", label: t("enabled"), tone: "cap" });
    for (const m of filteredCap) rows.push({ kind: "model", key: m.id, m, checked: true });
  }
  if (filteredOther.length > 0) {
    rows.push({ kind: "header", key: "h-other", label: t("available"), tone: "other" });
    for (const m of filteredOther) rows.push({ kind: "model", key: m.id, m, checked: false });
  }

  return (
    <>
    <Drawer
      title={
        <div className="flex items-center gap-2">
          <ApiOutlined />
          <span style={{ color: "var(--canvas-text)" }}>{t("api.settings")}</span>
        </div>
      }
      open={open}
      onClose={onClose}
      size={600}
      placement="right"
      closable={{ placement: "end" }}
      destroyOnHidden
      styles={{
        header: { background: "var(--canvas-bg)", borderBottom: "1px solid var(--canvas-border)" },
        body: { background: "var(--canvas-bg)", padding: 0, display: "flex", flexDirection: "column", height: "100%" },
        section: isDark ? { borderLeft: "1px solid #2c2c31" } : undefined,
      }}
    >
    <div className="model-config-wrap flex flex-col h-full">
      <style>{`
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
      {/* ===== Channel selector ===== */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: "var(--canvas-border)" }}>
        <span className="text-xs flex-shrink-0" style={{ color: "var(--canvas-text-dim)" }}>{t("channels")}:</span>
        <Select
          size="small"
          value={channelId}
          onChange={(v) => { setChannelId(v); setActiveCap("image"); }}
          disabled={showAddChannel}
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
          <div className="flex gap-1">
            <div className="flex flex-col gap-2" style={{ flex: 1 }}>
              <div className="flex flex-col gap-0.5">
                <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("name")}</span>
                <Input size="small" placeholder={t("my.api")} value={chForm.name} onChange={(e) => setChForm((f) => ({ ...f, name: e.target.value }))} style={{ width: "100%" }} autoFocus />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("base.url")}</span>
                <Input size="small" placeholder="https://api.openai.com/v1" value={chForm.baseUrl} onChange={(e) => setChForm((f) => ({ ...f, baseUrl: e.target.value }))} style={{ width: "100%" }} />
              </div>
            </div>
            <div className="flex flex-col gap-2" style={{ flex: 1 }}>
              <div className="flex gap-1">
                <div className="flex flex-col gap-0.5" style={{ flex: 1 }}>
                  <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("protocol")}</span>
                  <Select
                    size="small"
                    value={chForm.protocol}
                    onChange={(v) => setChForm((f) => ({ ...f, protocol: v }))}
                    style={{ width: "100%" }}
                    options={[
                      { label: t("protocol.openai"), value: "openai" },
                      { label: t("protocol.gemini"), value: "gemini" },
                      { label: t("protocol.ark"), value: "ark" },
                    ]}
                  />
                </div>
                <div className="flex flex-col gap-0.5" style={{ flex: 1 }}>
                  <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("preset")}</span>
                  <Select
                    size="small" style={{ width: "100%" }}
                    placeholder={t("preset")}
                    options={presets.map((p) => ({ label: p.name, value: p.name }))}
                    onChange={(name) => {
                      const p = presets.find((pr) => pr.name === name);
                      if (!p) return;
                      const fmt = (v: unknown) => (v && typeof v === "object" && Object.keys(v as object).length > 0 ? JSON.stringify(v, null, 2) : "");
                      setChForm((f) => ({
                        ...f,
                        baseUrl: p.baseUrl ?? "",
                        protocol: p.protocol || "openai",
                        config: fmt(p.config),
                      }));
                    }}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[12px]" style={{ color: "var(--canvas-text-muted)" }}>{t("api.key")}</span>
            <Input.Password
              placeholder={editChannelId ? t("api.key.keepblank") : "sk-..."} value={chForm.apiKey}
              onChange={(e) => setChForm((f) => ({ ...f, apiKey: e.target.value }))}
              style={{ width: "100%" }}
              iconRender={(v) => (v ? <EyeIcon style={{ color: "var(--canvas-text)" }} /> : <EyeOffIcon style={{ color: "var(--canvas-text)" }} />)}
            />
          </div>
          </div>
          </div>
          {/* 高级设置折叠区 */}
          <div className="flex flex-col gap-0.5">
            <button
              className="flex items-center gap-1 text-[12px] cursor-pointer"
              style={{ color: "var(--canvas-text-muted)", background: "transparent", border: "none", padding: 0, width: "fit-content", outline: "none", boxShadow: "none" }}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span style={{ display: "inline-block", width: 0, height: 0, borderLeft: "5px solid var(--canvas-text)", borderTop: "4px solid transparent", borderBottom: "4px solid transparent", transition: "transform 0.2s", transform: showAdvanced ? "rotate(90deg)" : "rotate(0deg)" }} />
              {t("advanced.settings")}
            </button>
            {showAdvanced && (
              <div className="flex flex-col gap-1.5 mt-0.5">
                {/* 合并后的 config 编辑器 */}
                <Input.TextArea
                  size="small"
                  placeholder={
                    '渠道高级配置，用于适配不同供应商的 API 格式\n' +
                    '所有字段均可留空 {}，未配置则不生效\n' +
                    '\n' +
                    '━━━ request 请求构造 ━━━\n' +
                    '执行顺序：transforms(后端 model_params.json) → auto-clean → mapping → body_patch\n' +
                    '\n' +
                    '  mapping          字段重映射：改名或移动到嵌套路径\n' +
                    '                   {"源字段": "目标.路径"}             移动并重命名\n' +
                    '                   {"ratio": "size"}                  ratio → size\n' +
                    '                   {"refImages": "extra_body.image"}  挪到嵌套\n' +
                    '                   {"images": "images[].image_url"}  数组展开（见下方）\n' +
                    '                   {"待删除字段": null}              删除该字段\n' +
                    '\n' +
                    '  body_patch       固定注入：deep merge 到最终请求体\n' +
                    '                   {"response_format": "url"}\n' +
                    '                   {"extra_body": {"return_base64": true}}\n' +
                    '\n' +
                    '  model_overrides  按模型覆盖（key 支持 fnmatch 通配符 * ?）\n' +
                    '                   匹配优先级：精确名 > 通配符\n' +
                    '                   可覆盖 mapping 和 body_patch\n' +
                    '\n' +
                    '━━━ protocol 协议配置 ━━━\n' +
                    '\n' +
                    '  endpoints        端点路径覆盖，可用 key：\n' +
                    '                   image.generations  纯文本生图\n' +
                    '                   image.edits        图生图/编辑（有参考图）\n' +
                    '                   video.generations  视频生成\n' +
                    '                   poll               异步轮询路径（自动拼接 taskId）\n' +
                    '                   例：{"image.generations": "/v1/images/generations",\n' +
                    '                        "poll": "/v1/tasks"}\n' +
                    '\n' +
                    '━━━ 数组映射语法 ━━━\n' +
                    '  {"images": "images[]"}            → images: ["u1","u2"]\n' +
                    '  {"images": "images[].image_url"}  → images: [{"image_url":"u1"},...]\n' +
                    '\n' +
                    '━━━ 完整示例 ━━━\n' +
                    '{\n' +
                    '  "request": {\n' +
                    '    "mapping": {\n' +
                    '      "ratio": "size",\n' +
                    '      "refImages": "extra_body.image"\n' +
                    '    },\n' +
                    '    "body_patch": {\n' +
                    '      "response_format": "url"\n' +
                    '    },\n' +
                    '    "model_overrides": {\n' +
                    '      "gpt-image-*": {\n' +
                    '        "mapping": {"ratio": "image_size"},\n' +
                    '        "body_patch": {"quality": "hd"}\n' +
                    '      }\n' +
                    '    }\n' +
                    '  },\n' +
                    '  "protocol": {\n' +
                    '    "endpoints": {\n' +
                    '      "image.generations": "/v1/images/generations",\n' +
                    '      "image.edits": "/v1/images/edits",\n' +
                    '      "poll": "/v1/tasks"\n' +
                    '    }\n' +
                    '}'
                  }
                  value={chForm.config}
                  onChange={(e) => setChForm((f) => ({ ...f, config: e.target.value }))}
                  rows={20}
                  style={{ fontSize: 12, fontFamily: "monospace", resize: "none", overflow: "auto" }}
                />
              </div>
            )}
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
              {t(tab.labelKey)}
              <span className="text-[12px] opacity-60">({count})</span>
            </button>
          );
        })}
      </div>

      {/* ===== Model list ===== */}
      <div className="p-5 flex-1 flex flex-col min-h-0 overflow-hidden" style={{ scrollbarGutter: "stable" }}>
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
            <div className="flex items-center gap-1.5 mb-3 flex-shrink-0">
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
            <div className="flex gap-1.5 mb-3 flex-shrink-0">
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
        open={!!deleteChannelId}
        title={t("delete.channel")}
        content={channels.find(c => c.id === deleteChannelId)?.name || ""}
        onOk={() => { if (deleteChannelId) deleteChannel(deleteChannelId); setChannelId(null); setDeleteChannelId(null); }}
        onCancel={() => setDeleteChannelId(null)}
      />
    </>
  );
}

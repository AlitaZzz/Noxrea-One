/**
 * API 设置抽屉 · 添加 / 编辑供应商表单视图。
 * 占据右栏整体（带返回），不再内联挤压模型列表。
 * 编辑态密钥预填掩码：眼睛按需拉明文、复制按需拉明文，留空提交则保持不变。
 */

"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ArrowLeftOutlined, CopyOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { useModelStore } from "@/lib/model-store";
import type { ModelProvider, ProviderPreset } from "@/lib/types/models";

interface Props {
  mode: "add" | "edit";
  /** 编辑态目标供应商（key 由父组件保证随目标切换而重挂载） */
  provider?: ModelProvider;
  presets: ProviderPreset[];
  /** 保存成功后回调（父组件负责切回详情视图并选中新供应商） */
  onDone: () => void;
  onCancel: () => void;
}

export default function ApiSettingsForm({ mode, provider, presets, onDone, onCancel }: Props) {
  const { t } = useTranslation();
  const { message } = useAppFeedback();
  const addProvider = useModelStore((s) => s.addProvider);
  const updateProvider = useModelStore((s) => s.updateProvider);
  const fetchProviderApiKey = useModelStore((s) => s.fetchProviderApiKey);

  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [protocol, setProtocol] = useState(provider?.protocol || "openai");
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? "");
  const [keyDirty, setKeyDirty] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [fetchingKey, setFetchingKey] = useState(false);
  const [saving, setSaving] = useState(false);

  const canSave = !!name.trim() && !!baseUrl.trim();

  const handleSave = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const ok =
        mode === "edit" && provider
          ? await updateProvider(provider.id, {
              name: name.trim(),
              baseUrl: baseUrl.trim(),
              protocol,
              // 未改动（仍为掩码）或留空 → 提交 undefined，保持原密钥
              apiKey: keyDirty && !apiKey.includes("****") ? (apiKey.trim() || undefined) : undefined,
            })
          : await addProvider(name.trim(), baseUrl.trim(), apiKey.trim(), protocol);
      // 失败保留表单内容，用户可直接改完重试（失败原因由 store 统一提示）
      if (!ok) return;
      message.success(mode === "edit" ? t("modelConfig.providerUpdated") : t("modelConfig.providerAdded"));
      onDone();
    } catch {
      // 401 等异常由全局流程处理（清 token + 跳登录），这里只兜住 rejection
    } finally {
      setSaving(false);
    }
  };

  // 点击小眼睛：首次揭示时从后端拉取明文密钥
  const handleKeyVisibleChange = async (visible: boolean) => {
    setKeyVisible(visible);
    if (visible && mode === "edit" && provider && !keyRevealed && !keyDirty) {
      setFetchingKey(true);
      try {
        const plain = await fetchProviderApiKey(provider.id);
        setApiKey(plain);
        setKeyRevealed(true);
      } catch {
        message.error(t("modelConfig.apiKeyFetchFailed"));
        setKeyVisible(false);
      }
      setFetchingKey(false);
    }
  };

  // 复制按钮：按需拉取明文后复制到剪贴板
  const handleCopyKey = async () => {
    if (mode !== "edit" || !provider) return;
    let text = apiKey;
    if (!keyRevealed && !keyDirty) {
      setFetchingKey(true);
      try {
        text = await fetchProviderApiKey(provider.id);
        setApiKey(text);
        setKeyRevealed(true);
        setKeyVisible(true);
      } catch {
        message.error(t("modelConfig.apiKeyFetchFailed"));
        setFetchingKey(false);
        return;
      }
      setFetchingKey(false);
    }
    try {
      await navigator.clipboard.writeText(text);
      message.success(t("modelConfig.apiKeyCopied"));
    } catch {
      message.error(t("modelConfig.apiKeyCopyFailed"));
    }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* 头部：返回 + 标题 */}
      <SheetHeader className="flex-row items-center gap-1 border-b border-border px-4 py-3">
        <Button size="sm" variant="ghost" iconOnly onClick={onCancel} aria-label={t("modelConfig.back")}>
          <ArrowLeftOutlined />
        </Button>
        <SheetTitle className="text-[15px] font-semibold">
          {mode === "edit" ? t("modelConfig.editProvider") : t("modelConfig.addProvider")}
        </SheetTitle>
      </SheetHeader>

      {/* 字段 */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <FieldGroup className="max-w-[560px] gap-4">
          <Field>
            <Label htmlFor="api-settings-name">{t("common.name")}</Label>
            <Input
              id="api-settings-name"
              placeholder={t("modelConfig.myApi")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field>
              <Label htmlFor="api-settings-preset">{t("modelConfig.preset")}</Label>
              <Select onValueChange={(presetName) => {
                const p = presets.find((pr) => pr.name === presetName);
                if (!p) return;
                setBaseUrl(p.baseUrl ?? "");
                setProtocol(p.protocol || "openai");
              }}>
                <SelectTrigger id="api-settings-preset" className="w-full"><SelectValue placeholder={t("modelConfig.preset")} /></SelectTrigger>
                <SelectContent>
                  {presets.map((preset) => <SelectItem key={preset.name} value={preset.name}>{preset.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <Label htmlFor="api-settings-protocol">{t("modelConfig.protocolLabel")}</Label>
              <Select value={protocol} onValueChange={setProtocol}>
                <SelectTrigger id="api-settings-protocol" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">{t("modelConfig.protocol.openai")}</SelectItem>
                  <SelectItem value="ark">{t("modelConfig.protocol.ark")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <Label htmlFor="api-settings-base-url">{t("modelConfig.baseUrl")}</Label>
            <Input
              id="api-settings-base-url"
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>
          <Field>
            <Label htmlFor="api-settings-api-key">{t("modelConfig.apiKey")}</Label>
            <div className="flex gap-1.5">
              <PasswordInput
                id="api-settings-api-key"
                className="flex-1"
                placeholder={mode === "edit" ? t("modelConfig.apiKeyKeepBlank") : "sk-..."}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setKeyDirty(true);
                }}
                visible={keyVisible}
                onVisibleChange={handleKeyVisibleChange}
                showLabel={t("auth.login.showPassword")}
                hideLabel={t("auth.login.hidePassword")}
              />
              {mode === "edit" && (
                <Button size="sm" variant="ghost" iconOnly onClick={handleCopyKey} loading={fetchingKey} aria-label={t("modelConfig.copy")}>
                  <CopyOutlined />
                </Button>
              )}
            </div>
          </Field>
        </FieldGroup>
        <SheetFooter className="mt-6 max-w-[560px] flex-row justify-end border-t border-border p-0 pt-4">
          <Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button disabled={!canSave} loading={saving} onClick={handleSave}>
            {mode === "edit" ? t("modelConfig.saveChanges") : t("modelConfig.addProvider")}
          </Button>
        </SheetFooter>
      </div>
    </div>
  );
}

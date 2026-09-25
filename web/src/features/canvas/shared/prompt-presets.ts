/**
 * 图片生成面板「预设」：提示词模板目录、令牌格式与展开逻辑。
 *
 * 预设与节点工具条「创作」菜单共用同一批后端模板（server/resources/prompt-template.json），
 * 本模块提供共享目录查询、图标映射与提交前令牌展开。
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, Wand2 } from "lucide-react";
import type { ComponentType, CSSProperties } from "react";

import { Back5sIcon } from "@/components/ui/icons/canvas/Back5sIcon";
import { CharacterFaceThreeViewIcon } from "@/components/ui/icons/canvas/CharacterFaceThreeViewIcon";
import { CharacterThreeViewIcon } from "@/components/ui/icons/canvas/CharacterThreeViewIcon";
import { Forward3sIcon } from "@/components/ui/icons/canvas/Forward3sIcon";
import { NineGridIcon } from "@/components/ui/icons/canvas/NineGridIcon";
import { Storyboard4Icon } from "@/components/ui/icons/canvas/Storyboard4Icon";
import { Storyboard25Icon } from "@/components/ui/icons/canvas/Storyboard25Icon";
import { api } from "@/lib/api/client";

export interface PromptPreset {
  id: string;
  kind: "preset" | "reverse";
  labelKey: string;
  order: number;
  template: string;
}

export type PresetIcon = ComponentType<{ className?: string; style?: CSSProperties }>;

/** Icons are visual hints only; the API owns the catalog and its identifiers. */
const presetIcons: Record<string, PresetIcon> = {
  reverse: FileText,
  characterFaceThreeView: CharacterFaceThreeViewIcon,
  characterThreeView: CharacterThreeViewIcon,
  nineGridScene: NineGridIcon,
  storyboard25: Storyboard25Icon,
  storyboard4: Storyboard4Icon,
  forward3s: Forward3sIcon,
  back5s: Back5sIcon,
};

export function presetIconOf(id: string): PresetIcon {
  return presetIcons[id] ?? Wand2;
}

/** chip 令牌纯文本格式：@[preset:id]（与「图片N」中文 mention 不冲突） */
export const PRESET_TOKEN_PATTERN = /@\[preset:([A-Za-z0-9_-]+)\]/g;

export function presetTokenOf(id: string): string {
  return `@[preset:${id}]`;
}

/** 按 id 查预设项（chip 渲染、令牌展开共用） */
export function findPreset(presets: PromptPreset[], id: string): PromptPreset | undefined {
  return presets.find((p) => p.id === id && p.kind === "preset");
}

/** The directory is shared by both menus; submission fetches afresh for hot updates. */
export function fetchPromptTemplates(): Promise<PromptPreset[]> {
  return api<PromptPreset[]>("/api/canvas/prompt-templates");
}

export function usePromptPresets(enabled = true) {
  return useQuery({ queryKey: ["canvas", "prompt-templates"], queryFn: fetchPromptTemplates, enabled });
}

/**
 * 提交前重取目录。未知、禁用或空模板必须拒绝提交，不能把令牌发给模型。
 */
export async function expandPresetTokens(text: string): Promise<string> {
  if (!text.includes("@[preset:")) return text;
  const templates = await fetchPromptTemplates();
  return text.replace(PRESET_TOKEN_PATTERN, (_token, id: string) => {
    const preset = findPreset(templates, id);
    if (!preset) throw new Error(`Preset "${id}" is unavailable or disabled`);
    if (!preset.template.trim()) throw new Error(`Preset "${id}" has an empty template`);
    return preset.template;
  });
}

/**
 * 同类覆盖插入：替换提示词中已有 preset 令牌（原位替换第一个、删除其余），无则追加到末尾。
 * 保证一个提示词框同时只承载一个预设。
 */
export function replacePresetToken(text: string, id: string): string {
  const token = presetTokenOf(id);
  let replaced = false;
  let next = text.replace(PRESET_TOKEN_PATTERN, () => {
    if (replaced) return "";
    replaced = true;
    return token;
  });
  if (!replaced) next = next ? `${next}\n${token}` : token;
  return next;
}

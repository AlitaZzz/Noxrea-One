/**
 * 生成面板「预设」：提示词模板目录、令牌格式与展开逻辑。
 *
 * 图片 / 文本生成面板与节点工具条「创作」菜单共用同一批后端模板
 * （server/resources/prompt-template.json，按 target 区分节点类型），
 * 本模块提供共享目录查询、图标映射与提交前令牌展开。
 *
 * 目录只有一份 query 缓存（PROMPT_TEMPLATES_QUERY_KEY，全量目录），
 * target 差异在 select 侧投影；画布门页预取同一份，面板挂载时必然命中。
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { Wand2 } from "lucide-react";
import type { ComponentType, CSSProperties } from "react";

import { Back5sIcon } from "@/components/ui/icons/canvas/Back5sIcon";
import { CharacterFaceThreeViewIcon } from "@/components/ui/icons/canvas/CharacterFaceThreeViewIcon";
import { CharacterThreeViewIcon } from "@/components/ui/icons/canvas/CharacterThreeViewIcon";
import { Forward3sIcon } from "@/components/ui/icons/canvas/Forward3sIcon";
import { LightCorrectionIcon } from "@/components/ui/icons/canvas/LightCorrectionIcon";
import { NineGridIcon } from "@/components/ui/icons/canvas/NineGridIcon";
import { ProductThreeViewIcon } from "@/components/ui/icons/canvas/ProductThreeViewIcon";
import { Storyboard4Icon } from "@/components/ui/icons/canvas/Storyboard4Icon";
import { Storyboard25Icon } from "@/components/ui/icons/canvas/Storyboard25Icon";
import { api } from "@/lib/api/client";

export interface BilingualText {
  zh: string;
  en: string;
}

export type PromptTarget = "image" | "text";

export interface PromptPreset {
  id: string;
  kind: "preset";
  target: PromptTarget;
  group: string;
  label: BilingualText;
  description: BilingualText;
  order: number;
  template: string;
}

export interface PresetGroup {
  id: string;
  label: BilingualText;
  order: number;
}

export interface PromptTemplateCatalog {
  groups: PresetGroup[];
  entries: PromptPreset[];
}

export type PresetIcon = ComponentType<{ className?: string; style?: CSSProperties }>;

/** Icons are visual hints only; the API owns the catalog and its identifiers. */
const presetIcons: Record<string, PresetIcon> = {
  characterFaceThreeView: CharacterFaceThreeViewIcon,
  characterThreeView: CharacterThreeViewIcon,
  productThreeView: ProductThreeViewIcon,
  cinematicLightCorrection: LightCorrectionIcon,
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
  return presets.find((p) => p.id === id);
}

/** 目录为内联双语：渲染期按当前语言取值（随 useTranslation 重渲染即时切换），禁止模块加载期定格语言 */
export function localizeText(text: BilingualText, language: string): string {
  return language === "en" ? text.en : text.zh;
}

/** 目录 query 唯一 key：全量目录一份缓存，target 投影在 select 侧完成，画布门页预取同一份 */
export const PROMPT_TEMPLATES_QUERY_KEY = ["canvas", "prompt-templates", "all"] as const;

/** 全量目录（服务端已过滤可选预设条目并按 order 排序），门页预取与提交前展开共用 */
export function fetchPromptTemplates(): Promise<PromptTemplateCatalog> {
  return api<PromptTemplateCatalog>("/api/canvas/prompt-templates");
}

/**
 * target 投影：条目按 target 过滤、分组只保留含当前条目的；
 * 全量目录已按 order 排序，过滤保序，分组沿用服务端排序。
 */
export function filterCatalogByTarget(
  catalog: PromptTemplateCatalog,
  target: PromptTarget
): PromptTemplateCatalog {
  const entries = catalog.entries.filter((entry) => entry.target === target);
  const usedGroups = new Set(entries.map((entry) => entry.group));
  return { groups: catalog.groups.filter((group) => usedGroups.has(group.id)), entries };
}

/** 稳定的 target 选择器：select 引用不稳定会在每次渲染重建结果对象 */
const TARGET_SELECTORS: Record<PromptTarget, (catalog: PromptTemplateCatalog) => PromptTemplateCatalog> = {
  image: (catalog) => filterCatalogByTarget(catalog, "image"),
  text: (catalog) => filterCatalogByTarget(catalog, "text"),
};

/**
 * 目录 query 公共选项：门页预取（fetchQuery）与两个 hook 共用同一份
 * key / queryFn / 驻留策略，三者不可漂移。
 *
 * gcTime 取 Infinity：门页预取后目录即画布会话的常驻数据，禁止被 GC——
 * 画布可能长时间无任何订阅者（无图片节点、未开面板、未选中节点），
 * 默认 5 分钟回收后重开面板会先落在空目录上（菜单空、已有 chip 误显示
 * 「预设已移除」），正是门页要消除的空态竞态；驻留策略由 query 自身声明，
 * 不依赖订阅者偶然在场。gcTime 属于 query 而非观察者，故门页的 fetchQuery
 * 也必须携带本选项，否则回收会发生在任何 hook 挂载之前。
 * 目录热更新不受影响：staleTime 沿用全局默认（30s），过期后挂载即后台刷新。
 */
export function promptTemplatesQueryOptions() {
  return {
    queryKey: PROMPT_TEMPLATES_QUERY_KEY,
    queryFn: fetchPromptTemplates,
    gcTime: Infinity,
  };
}

/**
 * 指定 target 的目录（分组 + 条目），生成面板 / 创作菜单按节点类型取各自的预设；
 * 省略 target 时返回全量目录，令牌展开依赖它覆盖跨类令牌。
 */
export function usePromptTemplateCatalog(target?: PromptTarget) {
  return useQuery({
    ...promptTemplatesQueryOptions(),
    select: target ? TARGET_SELECTORS[target] : undefined,
  });
}

/** 仅条目列表（全量目录）：mention chip、节点派生等只需要扁平条目 */
export function usePromptPresets() {
  return useQuery({
    ...promptTemplatesQueryOptions(),
    select: (catalog) => catalog.entries,
  });
}

/**
 * 提交前重取目录。未知、禁用或空模板必须拒绝提交，不能把令牌发给模型。
 */
export async function expandPresetTokens(text: string): Promise<string> {
  if (!text.includes("@[preset:")) return text;
  const { entries: templates } = await fetchPromptTemplates();
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

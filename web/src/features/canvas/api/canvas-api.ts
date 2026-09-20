/**
 * 画布相关 API 封装：提示词模板等配置下发接口。
 */
import { api } from "@/lib/api/client";

export interface PromptTemplateResult {
  type: string;
  template: string;
}

/**
 * 拉取指定类型的提示词模板（后端下发，支持热更新）。
 * @param params 额外参数（如光照面板的 intensity/azimuth/elevation/kelvin/color），
 *               以 query 追加，由后端模板插值成成稿提示词。
 */
export async function getPromptTemplate(
  type: string,
  params?: Record<string, string | number>
): Promise<string | null> {
  const search = new URLSearchParams({ type });
  for (const [key, value] of Object.entries(params ?? {})) search.set(key, String(value));
  const res = await api<PromptTemplateResult>(
    `/api/canvas/prompt-template?${search.toString()}`,
    { method: "GET" }
  );
  if (res.code !== 200 || !res.data) return null;
  return res.data.template;
}

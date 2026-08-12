/**
 * 画布相关 API 封装：提示词模板等配置下发接口。
 */
import { api } from "@/lib/api/client";

export interface PromptTemplateResult {
  type: string;
  template: string;
}

/** 拉取指定类型的提示词模板（后端下发，支持热更新）。 */
export async function getPromptTemplate(type: string): Promise<string | null> {
  const res = await api<PromptTemplateResult>(
    `/api/canvas/prompt-template?type=${encodeURIComponent(type)}`,
    { method: "GET" }
  );
  if (res.code !== 200 || !res.data) return null;
  return res.data.template;
}

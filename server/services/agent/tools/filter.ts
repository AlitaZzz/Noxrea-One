/**
 * Agent 工具过滤。
 * 根据当前激活的技能白名单（skill.md 的 tools 字段）过滤注入给 LLM 的 tools。
 * skills 为空或为空数组时兜底注入全部已注册工具。
 */

import { agentToolRegistry } from "./registry";
import { getSkill } from "../skills/loader";

/**
 * 解析当前轮应注入给 LLM 的 tools（OpenAI function-calling 格式）。
 *
 * @param skills 前端显式触发的技能名列表；空或 undefined → 注入全部工具
 */
export function resolveSkillTools(skills?: string[]): unknown[] {
  if (!skills || skills.length === 0) {
    return agentToolRegistry.getOpenAiTools();
  }

  const allowed = new Set<string>();
  for (const name of skills) {
    const skill = getSkill(name);
    skill?.meta.tools?.forEach((t: string) => allowed.add(t));
  }

  // 没有任何白名单声明时，兜底注入全部工具（避免技能漏配导致无工具可用）
  if (allowed.size === 0) {
    return agentToolRegistry.getOpenAiTools();
  }

  const all = agentToolRegistry.getOpenAiTools() as Array<{ function: { name: string } }>;
  return all.filter((t) => allowed.has(t.function.name));
}

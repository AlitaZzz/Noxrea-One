/**
 * Agent 工具过滤。
 * 根据 session 级别的 activeSkill（skill.md 的 tools 字段）过滤注入给 LLM 的 tools。
 * activeSkill 为 null 时注入全部已注册工具（普通对话模式）。
 */

import { agentToolRegistry } from "./registry";
import { getSkill } from "../skills/loader";

/**
 * 解析当前轮应注入给 LLM 的 tools（OpenAI function-calling 格式）。
 *
 * @param activeSkill session 当前激活的技能名；null/undefined -> 注入全部工具
 */
export function resolveSkillTools(activeSkill?: string | null): unknown[] {
  if (!activeSkill) {
    return agentToolRegistry.getOpenAiTools();
  }

  const skill = getSkill(activeSkill);
  const allowed = new Set<string>(skill?.meta.tools ?? []);

  // 技能未声明 tools 白名单时，兜底注入全部工具
  if (allowed.size === 0) {
    return agentToolRegistry.getOpenAiTools();
  }

  const all = agentToolRegistry.getOpenAiTools() as Array<{ function: { name: string } }>;
  return all.filter((t) => allowed.has(t.function.name));
}

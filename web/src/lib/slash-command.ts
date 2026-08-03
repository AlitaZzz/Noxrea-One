// ── 斜杠命令解析（纯函数，便于单测） ──
//
// 仅当整条输入以 "/" 开头且第一段命中已知 skill 时，才解析为真正的 /skill 触发；
// 其余情况当作普通文本，避免误伤。
//
// 设计要点：
// - 真正的触发：用户整条输入形如 "/art-asset-designer 设计一个日落场景"
// - SkillPanel 点击插入的 "/name"（末尾无参数）发送时同样会被解析命中

export interface ParsedCommand {
  /** 命中的 skill 名（未命中为 undefined） */
  skill?: string;
  /** 去掉 "/name" 后的剩余文本 */
  rest: string;
  /** 原始输入 */
  raw: string;
}

/**
 * @param input 原始输入
 * @param knownSkills 已知 skill 名列表（来自 /api/chat/skills）
 */
export function parseSlash(input: string, knownSkills: string[]): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { rest: trimmed, raw: trimmed };

  const spaceIdx = trimmed.indexOf(" ");
  const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).trim();
  if (!name || !knownSkills.includes(name)) {
    return { rest: trimmed, raw: trimmed };
  }

  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  return { skill: name, rest, raw: trimmed };
}

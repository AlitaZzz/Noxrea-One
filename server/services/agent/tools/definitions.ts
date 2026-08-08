/**
 * Agent 工具定义。
 * 定义供 LLM function-calling 使用的工具 schema，统一向中央注册器注册。
 * 工具由前端执行：后端透传 tool_call，前端在画布创建对应节点。
 * complete_skill 为 server 端元工具：后端拦截，不透传给前端。
 *
 * 本文件属于 agent 模块，与 capabilities/llm（前端 text 节点纯文本能力）完全解耦。
 */

import { z } from "zod";
import { agentToolRegistry, type AgentToolDefinition } from "./registry";

/** generate_image / generate_video 共用参数 schema */
const promptToolSchema = z.object({
  prompt: z.string().min(1),
});

const IMAGE_TOOL: AgentToolDefinition = {
  name: "generate_image",
  description:
    "仅在用户明确要求「生成/画出一张图片」这类图像产物时调用。" +
    "调用后系统会在用户的画布上创建一个图片节点并填入提示词，用户自行点击生成按钮出图——" +
    "这一步由系统完成，你无需在回复文字中重复输出或复述该提示词，只需简短告知已创建节点即可。" +
    "若用户只是索要一段提示词文字、描述、文案或解释（并未要求真正出图），不要调用本工具，直接以文字回复。" +
    "每次用户请求只调用一次本工具，不要为同一请求生成多个变体或多次调用。",
  parameters: {
    prompt: { type: "string", description: "图片生成的提示词，尽量具体地描述主体、风格、光影、构图" },
  },
  required: ["prompt"],
  execute: "client",
  label: "生成图片",
  zodSchema: promptToolSchema,
};

const VIDEO_TOOL: AgentToolDefinition = {
  name: "generate_video",
  description:
    "仅在用户明确要求「生成/制作一段视频」这类视频产物时调用。" +
    "调用后系统会在用户的画布上创建一个视频节点并填入提示词，用户自行点击生成按钮出片——" +
    "这一步由系统完成，你无需在回复文字中重复输出或复述该提示词，只需简短告知已创建节点即可。" +
    "若用户只是索要一段描述、文案或解释（并未要求真正出片），不要调用本工具，直接以文字回复。" +
    "每次用户请求只调用一次本工具，不要为同一请求生成多个变体或多次调用。",
  parameters: {
    prompt: { type: "string", description: "视频生成的提示词，描述画面内容、镜头运动、风格" },
  },
  required: ["prompt"],
  execute: "client",
  label: "生成视频",
  zodSchema: promptToolSchema,
};

agentToolRegistry.register(IMAGE_TOOL);
agentToolRegistry.register(VIDEO_TOOL);

// ── Server 端元工具 ──

const COMPLETE_SKILL_TOOL: AgentToolDefinition = {
  name: "complete_skill",
  description:
    "当技能任务已全部完成时调用此工具。调用后会话回到普通对话模式。" +
    "如果你认为当前技能的所有任务都已执行完毕，请调用此工具。",
  parameters: {},
  required: [],
  execute: "server",
  label: "完成技能",
  zodSchema: z.object({}).strict(),
};

agentToolRegistry.register(COMPLETE_SKILL_TOOL);

/** complete_skill 的工具名，用于后端拦截 */
export const COMPLETE_SKILL = "complete_skill";

/** 传给上游 LLM 的 tools 字段（兼容导出，等价于 registry.getOpenAiTools()） */
export const AGENT_TOOLS = agentToolRegistry.getOpenAiTools();

/** 按名字查工具定义 */
export const AGENT_TOOL_MAP: Record<string, AgentToolDefinition> = Object.fromEntries(
  [...agentToolRegistry.names()].map((n) => [n, agentToolRegistry.get(n)!])
);

export function isAgentTool(name: string): boolean {
  return agentToolRegistry.get(name) !== undefined;
}

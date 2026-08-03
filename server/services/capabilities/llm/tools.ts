// ── Agent 工具定义（OpenAI function calling schema） ──
//
// 工具在「前端」执行：后端只负责把 tools 透传给上游 LLM，
// 并把上游返回的 tool_calls 通过 SSE 转发给前端。
// 前端收到后在画布上创建对应节点并预填提示词，不自动起生成任务。
//
// 本文件不再维护硬编码数组，所有工具统一向 agentToolRegistry 注册。
// 新增节点类型（如音频/文本）只需在下方加一处 register(...)。

import { agentToolRegistry, type AgentToolDefinition } from "./registry";

const IMAGE_TOOL: AgentToolDefinition = {
  name: "generate_image",
  description:
    "当用户想要一张图片时调用。会在用户的画布上创建一个图片节点并填入提示词，" +
    "用户随后自行点击生成按钮出图。请把用户的描述整理成高质量的英文或中文绘画提示词。",
  parameters: {
    prompt: { type: "string", description: "图片生成的提示词，尽量具体地描述主体、风格、光影、构图" },
  },
  required: ["prompt"],
  execute: "client",
};

const VIDEO_TOOL: AgentToolDefinition = {
  name: "generate_video",
  description:
    "当用户想要一段视频时调用。会在用户的画布上创建一个视频节点并填入提示词，" +
    "用户随后自行点击生成按钮出片。请把用户的描述整理成高质量的视频生成提示词。",
  parameters: {
    prompt: { type: "string", description: "视频生成的提示词，描述画面内容、镜头运动、风格" },
  },
  required: ["prompt"],
  execute: "client",
};

agentToolRegistry.register(IMAGE_TOOL);
agentToolRegistry.register(VIDEO_TOOL);

// ── 示例扩展点 ──
// 新增一个节点类型工具只需在此注册一处（前端同步在 agent-tools.ts 注册 spawner），
// 无需改动任何分发逻辑。以下 generate_text 即为扩展验证示例。
const TEXT_TOOL: AgentToolDefinition = {
  name: "generate_text",
  description:
    "当用户想要一段文字/文案/台词时调用。会在用户的画布上创建一个文本节点并填入内容，" +
    "供后续编辑或串联到其他节点。请把用户的描述整理成合适的文字内容。",
  parameters: {
    prompt: { type: "string", description: "文本生成的要求，描述主题、语气、长度、用途" },
  },
  required: ["prompt"],
  execute: "client",
};

agentToolRegistry.register(TEXT_TOOL);

/** 传给上游 LLM 的 tools 字段（兼容导出，等价于 registry.getOpenAiTools()） */
export const AGENT_TOOLS = agentToolRegistry.getOpenAiTools();

/** 按名字查工具定义 */
export const AGENT_TOOL_MAP: Record<string, AgentToolDefinition> = Object.fromEntries(
  [...agentToolRegistry.names()].map((n) => [n, agentToolRegistry.get(n)!])
);

export function isAgentTool(name: string): boolean {
  return agentToolRegistry.get(name) !== undefined;
}

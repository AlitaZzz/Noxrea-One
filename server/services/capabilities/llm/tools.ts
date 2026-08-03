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
};

agentToolRegistry.register(IMAGE_TOOL);
agentToolRegistry.register(VIDEO_TOOL);

/** 传给上游 LLM 的 tools 字段（兼容导出，等价于 registry.getOpenAiTools()） */
export const AGENT_TOOLS = agentToolRegistry.getOpenAiTools();

/** 按名字查工具定义 */
export const AGENT_TOOL_MAP: Record<string, AgentToolDefinition> = Object.fromEntries(
  [...agentToolRegistry.names()].map((n) => [n, agentToolRegistry.get(n)!])
);

export function isAgentTool(name: string): boolean {
  return agentToolRegistry.get(name) !== undefined;
}

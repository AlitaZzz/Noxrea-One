/**
 * Agent 工具定义（画布操作）。
 * 定义供 LLM function-calling 使用的工具 schema，统一向中央注册器注册。
 * 全部工具由前端执行：后端透传 tool_call，前端在画布上执行对应操作并把结果回传。
 *
 * 生成链路（/generate 路由 + taskBinding）与本模块完全解耦：
 * agent 只创建预填 genSettings.prompt 的节点，不触发任何生成任务。
 */

import { z } from "zod";
import { agentToolRegistry, type AgentToolDefinition } from "./registry";

// 工具 kind 枚举是 LLM 契约，须与 web/src/features/canvas/agent/tools/executors.ts 的 TOOL_NODE_KINDS 保持一致（跨包无法共享类型）
const NODE_KINDS = ["text", "image", "video", "audio", "director", "group"] as const;

/** create_node 的批量条目 schema */
const createNodeItemSchema = z.object({
  kind: z.enum(NODE_KINDS),
  content: z.string().optional(),
  prompt: z.string().optional(),
  title: z.string().optional(),
  connectTo: z.array(z.string()).optional(),
});

const CREATE_NODE_TOOL: AgentToolDefinition = {
  name: "create_node",
  description:
    "在画布上创建一个或多个节点（单次最多 6 个）。\n" +
    "用户未指定数量时默认创建 1 个节点。\n" +
    "kind 语义：text=文本便签（content 为正文）；image=图片节点（prompt 为生成提示词）；" +
    "video=视频节点（prompt 为生成提示词）；audio=音频节点（prompt 预留）；director=导演台；group=编组容器（title 为组名）。\n" +
    "image/video 节点只预填提示词，不会自动生成内容，用户会自行点击生成——不要在文字里复述提示词。\n" +
    "connectTo：创建后要与哪些节点连线，值为已存在节点的 id，或同批次节点的序号（\"1\" 表示本批次第 1 个）。\n" +
    "返回结果会给出每个新节点分配到的 id，后续更新/连线必须引用这些 id。",
  parameters: {
    nodes: {
      type: "array",
      description: "要创建的节点列表",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", description: "节点类型", enum: [...NODE_KINDS] },
          content: { type: "string", description: "text 节点的正文内容" },
          prompt: { type: "string", description: "image/video/audio 节点的生成提示词" },
          title: { type: "string", description: "节点标题（group 为组名）" },
          connectTo: { type: "array", description: "要连线的目标：已存在节点 id 或同批次序号（\"1\"）", items: { type: "string" } },
        },
        required: ["kind"],
      },
    },
  },
  required: ["nodes"],
  execute: "client",
  label: "创建节点",
  zodSchema: z.object({ nodes: z.array(createNodeItemSchema).min(1).max(6) }),
};

const UPDATE_NODE_TOOL: AgentToolDefinition = {
  name: "update_node",
  description:
    "更新一个已存在节点的内容。优先于「删了重建」：修改文本正文、修改生成提示词、改标题都应使用本工具。\n" +
    "text 节点用 content 更新正文；image/video 节点用 prompt 更新生成提示词；title 更新标题（传空字符串清除标题）。",
  parameters: {
    nodeId: { type: "string", description: "目标节点 id" },
    content: { type: "string", description: "text 节点的新正文" },
    prompt: { type: "string", description: "image/video 节点的新生成提示词" },
    title: { type: "string", description: "新标题；空字符串 = 清除标题" },
  },
  required: ["nodeId"],
  execute: "client",
  label: "更新节点",
  zodSchema: z.object({
    nodeId: z.string().min(1),
    content: z.string().optional(),
    prompt: z.string().optional(),
    title: z.string().optional(),
  }),
};

const DELETE_NODES_TOOL: AgentToolDefinition = {
  name: "delete_nodes",
  description: "删除一个或多个节点（连线会一并移除，组节点只解除编组不删成员）。不可恢复，谨慎使用。",
  parameters: {
    nodeIds: { type: "array", description: "要删除的节点 id 列表", items: { type: "string" } },
  },
  required: ["nodeIds"],
  execute: "client",
  label: "删除节点",
  zodSchema: z.object({ nodeIds: z.array(z.string().min(1)).min(1) }),
};

const CONNECT_NODES_TOOL: AgentToolDefinition = {
  name: "connect_nodes",
  description: "在两个或多个已存在节点之间创建连线（source → target 方向）。",
  parameters: {
    edges: {
      type: "array",
      description: "连线列表",
      items: {
        type: "object",
        properties: {
          source: { type: "string", description: "起点节点 id" },
          target: { type: "string", description: "终点节点 id" },
        },
        required: ["source", "target"],
      },
    },
  },
  required: ["edges"],
  execute: "client",
  label: "连接节点",
  zodSchema: z.object({
    edges: z.array(z.object({ source: z.string().min(1), target: z.string().min(1) })).min(1),
  }),
};

const MOVE_NODE_TOOL: AgentToolDefinition = {
  name: "move_node",
  description:
    "移动一个节点到指定位置，或对齐到某个参照物。\n" +
    "提供 x/y（画布世界坐标，节点左上角）；或提供 alignTo：\"center\" 表示移到当前视口中心，也可为另一节点的 id 表示移到其右侧附近。x/y 与 alignTo 二选一。",
  parameters: {
    nodeId: { type: "string", description: "目标节点 id" },
    x: { type: "number", description: "世界坐标 x（节点左上角）" },
    y: { type: "number", description: "世界坐标 y（节点左上角）" },
    alignTo: { type: "string", description: "对齐目标：\"center\" 或另一节点 id" },
  },
  required: ["nodeId"],
  execute: "client",
  label: "移动节点",
  zodSchema: z.object({
    nodeId: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    alignTo: z.string().optional(),
  }),
};

const ARRANGE_CANVAS_TOOL: AgentToolDefinition = {
  name: "arrange_canvas",
  description: "整理画布：把所有节点重排为整齐网格（有连线时按流向排序）并自适应缩放。不要自己计算节点坐标，需要排版时调用本工具。",
  parameters: {},
  required: [],
  execute: "client",
  label: "整理画布",
  zodSchema: z.object({}).strict(),
};

const SET_VIEWPORT_TOOL: AgentToolDefinition = {
  name: "set_viewport",
  description: "移动视口：聚焦到某个节点（提供 nodeId），或跳转到指定坐标/缩放（提供 x/y/zoom，二选一）。",
  parameters: {
    nodeId: { type: "string", description: "要聚焦的节点 id" },
    x: { type: "number", description: "世界坐标 x" },
    y: { type: "number", description: "世界坐标 y" },
    zoom: { type: "number", description: "缩放级别（0.2-2，1 为原始大小）" },
  },
  required: [],
  execute: "client",
  label: "调整视口",
  zodSchema: z.object({
    nodeId: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    zoom: z.number().optional(),
  }),
};

const SELECT_NODES_TOOL: AgentToolDefinition = {
  name: "select_nodes",
  description: "选中画布上的一个或多个节点（高亮显示），可选同时把视口聚焦到这些节点。",
  parameters: {
    nodeIds: { type: "array", description: "要选中的节点 id 列表", items: { type: "string" } },
    focus: { type: "boolean", description: "是否把视口居中到选中节点" },
  },
  required: ["nodeIds"],
  execute: "client",
  label: "选中节点",
  zodSchema: z.object({
    nodeIds: z.array(z.string().min(1)).min(1),
    focus: z.boolean().optional(),
  }),
};

const MESSAGE_USER_TOOL: AgentToolDefinition = {
  name: "message_user",
  description:
    "把一段总结消息展示给用户。每次完成画布操作后，必须调用本工具简要说明做了什么（创建了哪些节点、id 是什么、下一步建议）。\n" +
    "本工具的内容就是给用户的最终回复：不超过 3 句，不要复述 prompt/content，不要罗列提示词要点。\n" +
    "调用本工具后本轮任务即视为完成，不要再调用其他工具，也不要再输出额外文字。",
  parameters: {
    text: { type: "string", description: "要展示给用户的消息（markdown）" },
  },
  required: ["text"],
  execute: "client",
  label: "回复用户",
  zodSchema: z.object({ text: z.string().min(1) }),
};

for (const tool of [
  CREATE_NODE_TOOL,
  UPDATE_NODE_TOOL,
  DELETE_NODES_TOOL,
  CONNECT_NODES_TOOL,
  MOVE_NODE_TOOL,
  ARRANGE_CANVAS_TOOL,
  SET_VIEWPORT_TOOL,
  SELECT_NODES_TOOL,
  MESSAGE_USER_TOOL,
]) {
  agentToolRegistry.register(tool);
}

/** 传给上游 LLM 的 tools 字段（等价于 registry.getOpenAiTools()） */
export const AGENT_TOOLS = agentToolRegistry.getOpenAiTools();

/** 按名字查工具定义 */
export const AGENT_TOOL_MAP: Record<string, AgentToolDefinition> = Object.fromEntries(
  [...agentToolRegistry.names()].map((n) => [n, agentToolRegistry.get(n)!])
);

export function isAgentTool(name: string): boolean {
  return agentToolRegistry.get(name) !== undefined;
}

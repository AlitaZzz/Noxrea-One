/**
 * Agent 工具定义（画布操作）。
 * 定义供 LLM function-calling 使用的工具 schema，统一向中央注册器注册。
 * 全部工具由前端执行：后端透传 tool_call，前端在画布上执行对应操作并把结果回传。
 *
 * 参数 schema 单一来源：只维护 zod schema（字段用 .describe() 写参数说明），
 * 上游 JSON Schema 由 registry.getOpenAiTools() 通过 z.toJSONSchema 派生。
 *
 * 生成链路（/generate 路由 + taskBinding）与本模块完全解耦：
 * agent 只创建预填 genSettings.prompt 的节点，不触发任何生成任务。
 */

import { z } from "zod/v4";
import { agentToolRegistry, type AgentToolDefinition } from "./registry";

// 工具 kind 枚举是 LLM 契约，须与 web/src/features/canvas/agent/tools/executors.ts 的 TOOL_NODE_KINDS 保持一致（跨包无法共享类型）
const NODE_KINDS = ["text", "image", "video", "audio", "director", "group"] as const;

/** intent 参数：模型每次调用的一句话说明，透传给前端聊天面板展示（工具行文案） */
const INTENT_DESC =
  "本次操作的一句话说明（10~30 字中文，动词开头，如「创建三个文本节点并连线」），将原样展示给用户";
const intentSchema = z.string().optional().describe(INTENT_DESC);

/** create_node 的批量条目 schema */
const createNodeItemSchema = z.object({
  kind: z.enum(NODE_KINDS).describe("节点类型"),
  content: z.string().optional().describe("text 节点的正文内容"),
  prompt: z.string().optional().describe("image/video/audio 节点的生成提示词"),
  title: z.string().optional().describe("节点标题（group 为组名）"),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'image/video 节点的生成参数键值对（image: quality/resolution/ratio/n；video: resolution/ratio/seconds/generateAudio/n/refMode，refMode 取 text/image/first-last/full 须与上游连线相符），如 {"ratio":"9:16"}'
    ),
  connectTo: z
    .array(z.string())
    .optional()
    .describe(
      "要连线的目标：已存在节点 id 或同批次序号（\"1\"）。方向须符合连线规则（text→text/image/video/audio；image→text/image/video；video→text/video；audio→text/audio/video）"
    ),
});

const edgeItemSchema = z.object({
  source: z.string().min(1).describe("起点节点 id"),
  target: z.string().min(1).describe("终点节点 id"),
});

const CREATE_NODE_TOOL: AgentToolDefinition = {
  name: "create_node",
  description:
    "在画布上创建一个或多个节点。\n" +
    "用户未指定数量时默认创建 1 个节点；需要的节点数量不受限制，全部放在一次调用中传入即可（不要分批）。\n" +
    "kind 语义：text=文本便签（content 为正文）；image=图片节点（prompt 为生成提示词）；" +
    "video=视频节点（prompt 为生成提示词）；audio=音频节点（prompt 预留）；director=导演台；group=编组容器（title 为组名）。\n" +
    "image/video 节点只预填提示词，不会自动生成内容，用户会自行点击生成——不要在文字里复述提示词。\n" +
    "用户提到生成参数（比例、分辨率、时长、张数等）时，image/video 节点必须在创建时通过 params 传入（如 {\"ratio\":\"9:16\"}），" +
    "不要把参数写进提示词文本，也不要只口头声称已设置。参数按当前模型配置校验：不支持的值自动取最接近档位（ratio）或默认值，结果中会逐项说明。\n" +
    "connectTo：创建后要与哪些节点连线，值为已存在节点的 id，或同批次节点的序号（\"1\" 表示本批次第 1 个）。\n" +
    "连线方向即数据流向，须符合画布规则（不合法的连线会被拒绝）：text→text/image/video/audio；image→text/image/video；video→text/video；audio→text/audio/video。\n" +
    "返回结果会给出每个新节点分配到的 id，后续更新/连线必须引用这些 id。",
  zodSchema: z.object({
    intent: intentSchema,
    nodes: z.array(createNodeItemSchema).min(1).describe("要创建的节点列表"),
  }),
  execute: "client",
  label: "创建节点",
};

const UPDATE_NODE_TOOL: AgentToolDefinition = {
  name: "update_node",
  description:
    "更新一个已存在节点的内容。优先于「删了重建」：修改文本正文、修改生成提示词、改标题、设置生成参数都应使用本工具。\n" +
    "text 节点用 content 更新正文；image/video 节点用 prompt 更新生成提示词；title 更新标题（传空字符串清除标题）；\n" +
    "params 设置生成参数（如 {\"ratio\":\"9:16\"}，image 支持 quality/resolution/ratio/n，" +
    "video 支持 resolution/ratio/seconds/generateAudio/n/refMode，以实际模型配置为准）。\n" +
    "video 的 refMode 为参考方式：text=文生视频、image=图生视频、first-last=首尾帧、full=全能参考；" +
    "须与上游连线和模型能力相符（如无任何图片上游时不能指定 image/first-last），不符时自动收敛到最近可用值并在结果中说明。\n" +
    "参数会按当前模型可用选项校验：不支持的值自动取最接近档位（ratio）或默认值，结果中会逐项说明。",
  zodSchema: z.object({
    intent: intentSchema,
    nodeId: z.string().min(1).describe("目标节点 id"),
    content: z.string().optional().describe("text 节点的新正文"),
    prompt: z.string().optional().describe("image/video 节点的新生成提示词"),
    title: z.string().optional().describe("新标题；空字符串 = 清除标题"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        '生成参数键值对（image: quality/resolution/ratio/n；video: resolution/ratio/seconds/generateAudio/n/refMode，refMode 取 text/image/first-last/full 须与上游连线相符），如 {"ratio":"9:16"}'
      ),
  }),
  execute: "client",
  label: "更新节点",
};

const DELETE_NODES_TOOL: AgentToolDefinition = {
  name: "delete_nodes",
  description: "删除一个或多个节点（连线会一并移除，组节点只解除编组不删成员）。不可恢复，谨慎使用；提交后客户端会先向用户请求确认。",
  zodSchema: z.object({
    intent: intentSchema,
    nodeIds: z.array(z.string().min(1)).min(1).describe("要删除的节点 id 列表"),
  }),
  execute: "client",
  label: "删除节点",
};

const CONNECT_NODES_TOOL: AgentToolDefinition = {
  name: "connect_nodes",
  description:
    "在两个或多个已存在节点之间创建连线（source → target 方向，即数据流向）。\n" +
    "方向须符合画布规则，不合法的连线会被拒绝：text→text/audio/image/video；image→text/image/video；video→text/video；audio→text/audio/video。\n" +
    "典型用法：图片是视频的上游（image→video，图生视频）；反向 video→image 不允许。",
  zodSchema: z.object({
    intent: intentSchema,
    edges: z.array(edgeItemSchema).min(1).describe("连线列表"),
  }),
  execute: "client",
  label: "连接节点",
};

const DELETE_EDGES_TOOL: AgentToolDefinition = {
  name: "delete_edges",
  description:
    "删除两个节点之间的连线（source → target 方向，同名反向的连线不受影响）。" +
    "仅用于移除连线；删除节点请用 delete_nodes。提交后客户端会先向用户请求确认。",
  zodSchema: z.object({
    intent: intentSchema,
    edges: z.array(edgeItemSchema).min(1).describe("要删除的连线列表"),
  }),
  execute: "client",
  label: "删除连线",
};

const DUPLICATE_NODE_TOOL: AgentToolDefinition = {
  name: "duplicate_node",
  description:
    "复制一个已存在节点到原节点旁，新节点保留原节点的提示词、生成参数和已生成内容，不复制连线" +
    "（需要同样连线时用 connect_nodes），也不继承组归属。group 节点不支持复制。用户说「再做一个一样的」「复制这个」时使用。",
  zodSchema: z.object({
    intent: intentSchema,
    nodeId: z.string().min(1).describe("要复制的节点 id"),
  }),
  execute: "client",
  label: "复制节点",
};

const MOVE_NODE_TOOL: AgentToolDefinition = {
  name: "move_node",
  description:
    "移动一个节点到指定位置，或对齐到某个参照物。\n" +
    "提供 x/y（画布世界坐标，节点左上角）；或提供 alignTo：\"center\" 表示移到当前视口中心，也可为另一节点的 id 表示移到其右侧附近。x/y 与 alignTo 二选一。",
  zodSchema: z.object({
    intent: intentSchema,
    nodeId: z.string().min(1).describe("目标节点 id"),
    x: z.number().optional().describe("世界坐标 x（节点左上角）"),
    y: z.number().optional().describe("世界坐标 y（节点左上角）"),
    alignTo: z.string().optional().describe('对齐目标："center" 或另一节点 id'),
  }),
  execute: "client",
  label: "移动节点",
};

const ARRANGE_CANVAS_TOOL: AgentToolDefinition = {
  name: "arrange_canvas",
  description: "整理画布：把画布上已有的全部节点重排为整齐网格（有连线时按流向排序）并自适应缩放。create_node 已自动排布新建节点，创建节点后无需调用本工具；仅当需要重排画布上已有内容时使用，不要自己计算节点坐标。",
  zodSchema: z.object({ intent: intentSchema }).strict(),
  execute: "client",
  label: "整理画布",
};

const SET_VIEWPORT_TOOL: AgentToolDefinition = {
  name: "set_viewport",
  description: "移动视口：聚焦到某个节点（提供 nodeId），或跳转到指定坐标/缩放（提供 x/y/zoom，二选一）。",
  zodSchema: z.object({
    intent: intentSchema,
    nodeId: z.string().optional().describe("要聚焦的节点 id"),
    x: z.number().optional().describe("世界坐标 x"),
    y: z.number().optional().describe("世界坐标 y"),
    zoom: z.number().optional().describe("缩放级别（0.2-2，1 为原始大小）"),
  }),
  execute: "client",
  label: "调整视口",
};

const SELECT_NODES_TOOL: AgentToolDefinition = {
  name: "select_nodes",
  description: "选中画布上的一个或多个节点（高亮显示），可选同时把视口聚焦到这些节点。",
  zodSchema: z.object({
    intent: intentSchema,
    nodeIds: z.array(z.string().min(1)).min(1).describe("要选中的节点 id 列表"),
    focus: z.boolean().optional().describe("是否把视口居中到选中节点"),
  }),
  execute: "client",
  label: "选中节点",
};

const GET_CANVAS_STATE_TOOL: AgentToolDefinition = {
  name: "get_canvas_state",
  description:
    "读取当前画布的最新名册（节点 id/类型/位置/尺寸/标题、连线、当前选择、视口），返回 JSON。\n" +
    "名册不含节点内容（正文与提示词），需要内容时用 get_node_detail。\n" +
    "对画布当前状态拿不准时（节点是否存在、是否被选中、位置与连线）先调用本工具确认，再执行操作；" +
    "不要依据历史消息里的旧状态做判断。\n" +
    "超大画布截断时，可用 region 按坐标范围分段多次调用，每次读取一个矩形区域内的节点。",
  zodSchema: z.object({
    intent: intentSchema,
    region: z
      .object({
        minX: z.number().describe("范围左边界（画布坐标）"),
        maxX: z.number().describe("范围右边界"),
        minY: z.number().describe("范围上边界"),
        maxY: z.number().describe("范围下边界"),
      })
      .describe(
        "可选。按坐标范围过滤，只返回与该矩形相交的节点（及两端都在范围内的连线），用于超大画布分段读取"
      )
      .optional(),
  }),
  execute: "client",
  label: "查看画布状态",
};

const GET_NODE_DETAIL_TOOL: AgentToolDefinition = {
  name: "get_node_detail",
  description:
    "读取一个或多个节点的完整内容（文本正文、生成提示词、标题），返回 JSON。\n" +
    "画布名册不含节点内容：凡涉及节点内容的读取、总结、引用或编辑，必须先用本工具读取完整内容；" +
    "不要凭节点标题猜测内容。可一次传多个 nodeIds 批量读取。",
  zodSchema: z.object({
    intent: intentSchema,
    nodeIds: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        '要读取的节点 id 列表（支持批量），例如 ["v-abc123"]；当前选中节点 id 在快照 selection 里'
      ),
  }),
  execute: "client",
  label: "读取节点内容",
};

const MESSAGE_USER_TOOL: AgentToolDefinition = {
  name: "message_user",
  description:
    "把一段总结消息展示给用户。每次完成画布操作后，必须调用本工具简要说明做了什么（创建了哪些节点、id 是什么、下一步建议）。\n" +
    "本工具的内容就是给用户的最终回复：不超过 3 句，不要复述 prompt/content，不要罗列提示词要点。\n" +
    "调用本工具后本轮任务即视为完成，不要再调用其他工具，也不要再输出额外文字。",
  zodSchema: z.object({
    intent: intentSchema,
    text: z.string().min(1).describe("要展示给用户的消息（markdown）"),
  }),
  execute: "client",
  label: "回复用户",
};

for (const tool of [
  CREATE_NODE_TOOL,
  UPDATE_NODE_TOOL,
  DELETE_NODES_TOOL,
  CONNECT_NODES_TOOL,
  DELETE_EDGES_TOOL,
  DUPLICATE_NODE_TOOL,
  MOVE_NODE_TOOL,
  ARRANGE_CANVAS_TOOL,
  SET_VIEWPORT_TOOL,
  SELECT_NODES_TOOL,
  GET_CANVAS_STATE_TOOL,
  GET_NODE_DETAIL_TOOL,
  MESSAGE_USER_TOOL,
]) {
  agentToolRegistry.register(tool);
}

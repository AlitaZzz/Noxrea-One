# Skill / Tool 统一调度架构

> 本文档描述 LLM Agent 在画布上创建节点的能力调度设计：
> 自然语言指令 → LLM 生成 `tool_call` → 前端在画布建节点；
> 以及 `/skill` 斜杠命令如何真正触发提示词型 Skill。

---

## 1. 设计原则

- **Skill 与 Tool 解耦**：Skill 是纯提示词包（一个目录 + `skill.md`），只做 system 提示词注入；Tool 是 function-calling 能力，单独注册到一个中央 `AgentToolRegistry`。
- **集中化注册**：所有 Tool 通过中央注册器注册，逻辑不散落。
- **扩展 = 加一个文件 / 一处注册**：新增 Tool 改 `tools.ts` 一处 + `agent-tools.ts` 注册一处；新增 Skill 加一个目录。
- **复用优先**：不推翻现有链路（`chat.ts` 的 `payload.skills` 注入、续轮状态机全部保留），只重构其中散落硬编码的部分。

## 2. 两类能力

| 类型 | 是什么 | 在哪定义 | 触发方式 |
|---|---|---|---|
| Skill（提示词） | 目录 `server/resources/skills/<name>/skill.md`，frontmatter + 正文 | `skills/loader.ts` 扫描目录 | `/<name> 参数` 或 SkillPanel 点击 |
| Tool（函数调用） | LLM 可用的能力，OpenAI function-calling schema | `tools.ts` 向 `agentToolRegistry` 注册 | LLM 自主选择 `tool_call` |

**Skill 永远是纯提示词**，不挂任何 handler。工具执行位置标记 `execute: "client"`（前端建节点）/`"server"`（预留扩展）。

## 3. 目录结构（关键文件）

```
server/
├── services/capabilities/llm/
│   ├── registry.ts            # 中央 AgentToolRegistry（新建）
│   ├── tools.ts               # 改为"向 registry 注册"式（不再裸数组）
│   └── skills/
│       └── loader.ts          # 目录扫描返回 SkillMeta（保留）
└── http/routes/chat.ts        # tools 来源改为 registry.getOpenAiTools()

web/src/
├── lib/
│   ├── agent-tools.ts         # executeAgentTools 按注册表分发 + registerAgentSpawner
│   └── slash-command.ts       # parseSlash 纯函数（新建）
├── hooks/use-chat-stream.ts   # sendChat(text, skills?) 透传 skills
└── components/canvas/ChatPanel.tsx  # 发送前 parseSlash
```

> Skill 目录 `server/resources/skills/<name>/skill.md` **约定不变**，仍是唯一必需文件。

## 4. 后端：AgentToolRegistry

`server/services/capabilities/llm/registry.ts` 导出单例：

```ts
agentToolRegistry.register({ name, description, parameters, required, execute });
agentToolRegistry.getOpenAiTools(); // → 传给上游 LLM 的 tools 数组
agentToolRegistry.get(name);        // → 查定义
agentToolRegistry.names();          // → 所有已注册工具名
```

`tools.ts` 模块加载时即调用 `register(...)`（副作用），`chat.ts` 通过
`import "@server/services/capabilities/llm/tools"` 确保注册发生，并用
`agentToolRegistry.getOpenAiTools()` 作为 `body.tools`。

## 5. 前端：工具执行注册表

`web/src/lib/agent-tools.ts`：

```ts
registerAgentSpawner("generate_image", (args) => spawnImageNode(String(args.prompt ?? "")), "图像");
registerAgentSpawner("generate_video", (args) => spawnVideoNode(String(args.prompt ?? "")), "视频");
registerAgentSpawner("generate_text",  (args) => spawnTextNode(String(args.prompt ?? "")),  "文本");

executeAgentTools(calls); // 按注册表分发，不再有 if-else
```

每个 spawner 负责：建节点 + `findFreePosition` 定位 + 预填 `genSettings.content`/prompt。
**新增节点类型**只需在此注册一行（同时后端 `tools.ts` 注册 schema），无需改动分发逻辑。

## 6. /skill 斜杠真触发

`web/src/lib/slash-command.ts` 的 `parseSlash(input, knownSkills)`：

- 仅当整条输入以 `/` 开头且第一段命中已知 skill 名才解析为触发；
- 返回 `{ skill?, rest, raw }`，`rest` 为去掉 `/name` 后的真实指令。

`ChatPanel` 发送前：

```ts
const parsed = parseSlash(text, skillNames);
void sendChat(parsed.skill ? parsed.rest : text, parsed.skill ? [parsed.skill] : undefined);
```

`use-chat-stream.ts` 的 `sendChat(text, skills?)` 把 `skills` 透传到
`/api/chat/stream` 的 body，后端 `payload.skills` 注入 system（接口已支持）。

SkillPanel 点击插入 `/name` 后，用户直接发送即被解析为真触发。

## 7. 端到端数据流

```
用户输入 "/art-asset-designer 设计一个日落场景"
  → ChatPanel.parseSlash → skill="art-asset-designer", rest="设计一个日落场景"
  → sendChat(rest, ["art-asset-designer"])
  → POST /api/chat/stream { messages, skills:["art-asset-designer"] }
  → chat.ts 把 getSkill("art-asset-designer").content 注入 system
  → LLM 返回 tool_call(generate_image, {prompt:...})
  → SSE 转发 tool_call → executeAgentTools → registerAgentSpawner("generate_image") 建节点
  → 续轮回填 tool 结果（最多 8 轮）→ 对话完成
```

## 8. 扩展指南

### 新增一个 Tool（如音频生成）

1. `server/services/capabilities/llm/tools.ts` 加：
   ```ts
   agentToolRegistry.register({ name: "generate_audio", description: "...", parameters: { prompt: {...} }, required: ["prompt"], execute: "client" });
   ```
2. `web/src/lib/agent-tools.ts` 加：
   ```ts
   registerAgentSpawner("generate_audio", (args) => spawnAudioNode(String(args.prompt ?? "")), "音频");
   ```

### 新增一个 Skill

在 `server/resources/skills/<name>/` 放 `skill.md`（frontmatter: name/title/description/category/appliesTo）。
自动出现在 `/api/chat/skills`、斜杠提示、LLM 注入，无需改代码。

## 9. 风险与注意

- **注册时机**：`tools.ts` 必须在路由处理前被 import 一次，否则 `getOpenAiTools()` 为空（已在 `chat.ts` 显式 import 兜底）。
- **仅整条以 `/` 开头才真触发**：避免误伤普通文本中的 `/xxx`。
- **不动现有续轮状态机（最多 8 轮）与 skill.md 目录约定**，回归风险低。

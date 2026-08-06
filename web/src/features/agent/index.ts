/**
 * Agent feature 公开 API barrel。
 */

// ── 组件 ──
export { default as AgentDrawer } from "./components/AgentDrawer";
export { default as SkillPanel } from "./components/SkillPanel";

// ── Hooks ──
export { useAgentStream } from "./hooks/use-agent-stream";
export { useAgentSessions } from "./hooks/use-agent-sessions";

// ── API ──
export { agentApi } from "./api";

// ── 工具 ──
export {
  executeAgentTools,
  registerAgentSpawner,
  getAgentSpawner,
} from "./tools/agent-tools";

// ── 类型 ──
export type {
  StreamAgentOptions,
  ToolResultOptions,
  ChatRole,
  ChatMessage,
  ToolCallView,
  AgentToolCall,
  AgentToolResult,
  AgentSpawner,
  AddNodes,
  FindFreePosition,
  SessionListItem,
} from "./types";

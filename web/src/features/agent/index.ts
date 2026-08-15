/**
 * Agent feature 公开 API barrel。
 */

// ── 组件 ──
export { default as AgentDrawer } from "./components/AgentDrawer";
export { default as SkillPanel } from "./components/SkillPanel";

// ── Hooks ──
export { useAgentSessions } from "./hooks/use-agent-sessions";
export { useAgentStream } from "./hooks/use-agent-stream";

// ── API ──
export { agentApi } from "./api";

// ── 工具 ──
export {
  executeAgentTools,
  getAgentSpawner,
  registerAgentSpawner,
} from "./tools/agent-tools";

// ── 类型 ──
export type {
  AddNodes,
  AgentSpawner,
  AgentToolCall,
  AgentToolResult,
  ChatMessage,
  ChatRole,
  FindFreePosition,
  SessionListItem,
  StreamAgentOptions,
  ToolCallView,
  ToolResultOptions,
} from "./types";

/**
 * Agent 提议-确认的幻影蒙层：待确认操作的目标节点上叠加红色半透明 + 虚线描边，
 * 提示用户哪些节点将被操作。纯展示层，不拦截交互（pointer-events: none）。
 */
"use client";

export default function AgentGhostOverlay() {
  return <div className="agent-ghost-overlay" aria-hidden />;
}

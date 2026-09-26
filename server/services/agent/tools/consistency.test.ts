/**
 * Agent 工具四处注册一致性测试。
 *
 * 工具契约目前分散在四处（跨包无法共享类型，web 侧靠源码文本核对，T8b 共享包落地后收敛为真实单一来源）：
 * 1. server/services/agent/tools/definitions.ts —— LLM function-calling 注册（唯一权威）
 * 2. web …/tools/executors.ts —— 前端执行器 switch 分支（message_user 由流 hook 展示，不在执行器）
 * 3. web …/tools/Meta.tsx —— 操作行图标/文案 TOOL_META
 * 4. web …/hooks/use-canvas-agent-stream.ts —— CONFIRM_REQUIRED_TOOLS 提议-确认集合
 * 另核对 NODE_KINDS（definitions）=== TOOL_NODE_KINDS（executors）。
 *
 * 任何一侧漏改（新增工具忘写执行分支 / 忘配图标 / 忘配确认集合）都会在此报红。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { agentToolRegistry } from "./registry";

const here = path.dirname(fileURLToPath(import.meta.url));
const webToolsDir = path.resolve(here, "../../../../web/src/features/canvas/agent/tools");
const webAgentDir = path.resolve(here, "../../../../web/src/features/canvas/agent");

const read = (p: string) => readFileSync(p, "utf-8");

beforeEach(async () => {
  // definitions.ts 的注册是模块加载副作用；此测试文件率先 import registry，
  // 需保证 definitions 已被加载
  await import("./definitions");
});

/** 从执行器源码提取 switch 分支工具名 */
function executorToolNames(): string[] {
  const src = read(path.join(webToolsDir, "executors.ts"));
  return [...src.matchAll(/case "(\w+)":/g)].map((m) => m[1]);
}

/** 从 Meta.tsx 提取 TOOL_META 键 */
function metaToolNames(): string[] {
  const src = read(path.join(webToolsDir, "Meta.tsx"));
  const body = src.slice(src.indexOf("export const TOOL_META"));
  return [...body.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]);
}

/** 从流 hook 源码提取 CONFIRM_REQUIRED_TOOLS 集合 */
function confirmRequiredTools(): string[] {
  const src = read(path.join(webAgentDir, "hooks", "use-canvas-agent-stream.ts"));
  const m = /CONFIRM_REQUIRED_TOOLS = new Set\(\[([^\]]*)\]\)/.exec(src);
  expect(m, "use-canvas-agent-stream.ts 中找不到 CONFIRM_REQUIRED_TOOLS 定义").toBeTruthy();
  return [...m![1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
}

/** 从 definitions.ts 提取 NODE_KINDS 枚举 */
function serverNodeKinds(): string[] {
  const src = read(path.join(here, "definitions.ts"));
  const m = /const NODE_KINDS = \[([^\]]*)\]/.exec(src);
  expect(m, "definitions.ts 中找不到 NODE_KINDS").toBeTruthy();
  return [...m![1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
}

/** 从 executors.ts 提取 TOOL_NODE_KINDS 枚举 */
function webNodeKinds(): string[] {
  const src = read(path.join(webToolsDir, "executors.ts"));
  const m = /const TOOL_NODE_KINDS = \[([^\]]*)\]/.exec(src);
  expect(m, "executors.ts 中找不到 TOOL_NODE_KINDS").toBeTruthy();
  return [...m![1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
}

describe("Agent 工具四处注册一致性", () => {
  it("注册器非空（definitions 副作用已生效）", () => {
    expect(agentToolRegistry.names().length).toBeGreaterThanOrEqual(10);
  });

  it("每个 client 工具都有执行器分支（message_user 由流 hook 展示，除外）", () => {
    const clientTools = agentToolRegistry
      .names()
      .filter((n) => agentToolRegistry.get(n)!.execute === "client");
    const executors = new Set(executorToolNames());
    const missing = clientTools.filter((n) => n !== "message_user" && !executors.has(n));
    expect(missing, "注册了但执行器缺分支的工具").toEqual([]);
  });

  it("执行器分支都已注册（防止 web 侧残留已下线工具）", () => {
    const registered = new Set(agentToolRegistry.names());
    const orphan = executorToolNames().filter((n) => !registered.has(n));
    expect(orphan, "执行器存在但未注册的工具").toEqual([]);
  });

  it("TOOL_META 覆盖全部注册工具（新增工具必须配图标与文案）", () => {
    const meta = new Set(metaToolNames());
    const missing = agentToolRegistry.names().filter((n) => !meta.has(n));
    expect(missing, "已注册但 TOOL_META 缺条目的工具").toEqual([]);
  });

  it("CONFIRM_REQUIRED_TOOLS 都已注册且由前端执行", () => {
    const confirm = confirmRequiredTools();
    expect(confirm.length, "确认集合不应为空").toBeGreaterThan(0);
    for (const name of confirm) {
      const def = agentToolRegistry.get(name);
      expect(def, `CONFIRM_REQUIRED_TOOLS 中的 ${name} 未注册`).toBeTruthy();
      expect(def!.execute, `CONFIRM_REQUIRED_TOOLS 中的 ${name} 不是 client 工具`).toBe("client");
    }
  });

  it("NODE_KINDS（server）与 TOOL_NODE_KINDS（web）完全一致", () => {
    expect(webNodeKinds()).toEqual(serverNodeKinds());
  });
});

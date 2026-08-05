"use client";

import { createImageNode, createVideoNode } from "@/lib/node-defaults";
import type { AnyNode, GenSettings, VideoGenSettings } from "@/lib/types";

/** 后端 tool_call 结构（与 /api/chat SSE 的 tool_call 事件一致） */
export interface AgentToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

/** 执行单个工具后回填给 LLM 的结果（带 role:"tool"） */
export interface AgentToolResult {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** 位置计算函数签名（由调用方注入） */
export type FindFreePosition = (size: { width: number; height: number }) => { x: number; y: number };

/** 添加节点函数签名（由调用方注入） */
export type AddNodes = (nodes: AnyNode[]) => void;

/** 解析工具参数为对象（后端可能是 JSON 字符串） */
function parseArgs(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null) return raw;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/**
 * 在画布中心附近创建一个图像节点，并预填生成 prompt。
 * 不自动出图，由用户自行点击生成。
 */
function spawnImageNode(prompt: string, findFreePosition: FindFreePosition): AnyNode {
  const node = createImageNode({ x: 0, y: 0 });
  const w = (node.style?.width as number) ?? 300;
  const h = (node.style?.height as number) ?? 200;
  node.position = findFreePosition({ width: w, height: h });
  const genSettings: GenSettings = {
    prompt,
    modelKey: "",
    quality: "",
    resolution: "",
    ratio: "",
    refOrder: [],
    n: 1,
  };
  node.data = { ...node.data, genSettings } as typeof node.data;
  return node;
}

/**
 * 在画布中心附近创建一个视频节点，并预填生成 prompt。
 * 不自动出图，由用户自行点击生成。
 */
function spawnVideoNode(prompt: string, findFreePosition: FindFreePosition): AnyNode {
  const node = createVideoNode({ x: 0, y: 0 });
  const w = (node.style?.width as number) ?? 300;
  const h = (node.style?.height as number) ?? 200;
  node.position = findFreePosition({ width: w, height: h });
  const genSettings: VideoGenSettings = {
    prompt,
    modelKey: "",
    resolution: "",
    ratio: "",
    seconds: 5,
    generateAudio: false,
    refOrder: [],
    refAudioOrder: [],
    n: 1,
  };
  node.data = { ...node.data, genSettings } as typeof node.data;
  return node;
}

// ── 工具执行注册表（集中化分发，避免 if-else 蔓延） ──
//
// 每个工具名注册一个 spawner：接收解析后的参数和 findFreePosition，返回一个已定位、已预填的画布节点。
// 新增节点类型时，只需在此注册一处（同时到后端 tools.ts 注册工具 schema），
// 无需改动 executeAgentTools 的分发逻辑。

export type AgentSpawner = (args: Record<string, unknown>, findFreePosition: FindFreePosition) => AnyNode;

const spawnerRegistry = new Map<string, AgentSpawner>();
const labelRegistry = new Map<string, string>();

/** 注册一个工具的处理器（名字 -> spawner + 中文标签） */
export function registerAgentSpawner(name: string, spawner: AgentSpawner, label: string): void {
  spawnerRegistry.set(name, spawner);
  labelRegistry.set(name, label);
}

/** 取工具对应的 spawner（未注册返回 undefined） */
export function getAgentSpawner(name: string): AgentSpawner | undefined {
  return spawnerRegistry.get(name);
}

// 注册现有节点工具（新增类型只需在此加一行 + 后端 tools.ts 注册 schema）
registerAgentSpawner("generate_image", (args, fp) => spawnImageNode(String(args.prompt ?? ""), fp), "图像");
registerAgentSpawner("generate_video", (args, fp) => spawnVideoNode(String(args.prompt ?? ""), fp), "视频");

/**
 * 批量执行 Agent 下发的工具调用。
 * 按注册表分发：命中 spawner 则在画布建节点并预填 prompt（不自动生成）；
 * 未注册的工具标记为未支持，返回占位结果。
 *
 * 返回带 role:"tool" 的结果数组，供续轮时回填给 LLM。
 *
 * @param toolCalls 工具调用列表
 * @param addNodes 由调用方注入的节点添加函数（通常来自 canvas-store）
 * @param findFreePosition 由调用方注入的位置计算函数
 */
export function executeAgentTools(
  toolCalls: AgentToolCall[],
  addNodes: AddNodes,
  findFreePosition: FindFreePosition,
): AgentToolResult[] {
  const results: AgentToolResult[] = [];

  for (const call of toolCalls) {
    const name = call.function?.name ?? "";
    const args = parseArgs(call.function?.arguments ?? {});
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const spawner = getAgentSpawner(name);
    const label = labelRegistry.get(name) ?? name;

    let resultContent: string;
    if (!spawner) {
      resultContent = `工具「${name}」当前不支持，已忽略。`;
    } else if (!prompt) {
      resultContent = "未提供 prompt，已跳过节点创建。";
    } else {
      addNodes([spawner(args, findFreePosition)]);
      resultContent = `已在画布创建${label}节点并预填 prompt：「${prompt}」，请用户自行点击生成。`;
    }

    results.push({
      role: "tool",
      tool_call_id: call.id,
      content: resultContent,
    });
  }

  return results;
}

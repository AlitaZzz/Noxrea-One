/**
 * 视频参考方式（refMode）的共享规则。
 *
 * refMode 的合法值由两层约束共同决定：
 * - 上游参考：由连线推导（视频/音频 → 仅全能；1 图 → 图生/全能；2 图 → 首尾帧/全能；≥3 图 → 仅全能；无 → 文生）；
 * - 模型能力声明：capabilities.refMode.options（未声明或为空 = 模型侧不设限，与面板隐藏控件的行为一致）。
 *
 * 视频生成面板（VideoGenerationPanel）与画布 Agent 参数校验（agent/tools/executors）
 * 共用本模块，保证两侧的可用范围与回退收敛规则永远一致。
 */

import type { AnyNode } from "@/features/canvas/types";

import { collectLiveRefs } from "./ref-order";

/** 参考方式标准值（模型可能声明自定义值，故推导与收敛均按 string 处理） */
export type StandardRefMode = "text" | "image" | "first-last" | "full";

const STANDARD_REF_MODES: readonly StandardRefMode[] = ["text", "image", "first-last", "full"];

/**
 * 由实时参考列表推导可用参考方式（纯函数）。
 * 列表来自 collectLiveRefs（图 / 音 / 视频各自的去重 src 列表）。
 */
export function deriveAllowedRefModes(live: {
  refOrder: readonly string[];
  refAudioOrder: readonly string[];
  refVideoOrder: readonly string[];
}): string[] {
  if (live.refVideoOrder.length > 0 || live.refAudioOrder.length > 0) return ["full"];
  if (live.refOrder.length === 1) return ["image", "full"]; // 1 张图：图生视频/全能参考
  if (live.refOrder.length === 2) return ["first-last", "full"]; // 2 张图：首尾帧/全能参考
  if (live.refOrder.length >= 3) return ["full"]; // ≥3 张图：仅全能参考
  return ["text"]; // 无图片/视频/音频参考（含只有文本上游）→ 只能文生视频
}

/** 从画布 nodes/edges 推导某视频节点当前可用的参考方式 */
export function allowedRefModesFor(
  nodeId: string,
  nodes: AnyNode[],
  edges: ReadonlyArray<{ source: string; target: string }>,
): string[] {
  return deriveAllowedRefModes(collectLiveRefs(nodes, [...edges], nodeId));
}

export interface ResolvedRefMode {
  /** 收敛后的参考方式（desired 合法时即 desired） */
  value: string;
  /** 收敛原因说明；desired 合法时为 null */
  note: string | null;
}

/**
 * 把期望的参考方式收敛到合法值（纯函数）：
 * desired 须同时满足「上游参考推导范围」与「模型能力声明」（modelOptions 非空时）。
 * 不合法时按 full → 其余合法项 → full（模型不设限时）→ text 的顺序回退，并给出原因。
 * 返回值必属 allowed ∪ {"full","text"}，重复调用对相同输入幂等，调用方可安全循环纠偏。
 */
export function resolveRefMode(
  desired: string | undefined,
  modelOptions: readonly string[],
  allowed: readonly string[],
): ResolvedRefMode {
  const modelConstrained = modelOptions.length > 0;
  const modelAllows = (m: string) => !modelConstrained || modelOptions.includes(m);
  const legal = allowed.filter(modelAllows);
  const fallback = (): string => {
    if (legal.includes("full")) return "full";
    if (legal.length > 0) return legal[0];
    return allowed.includes("full") ? "full" : "text";
  };

  if (desired) {
    if (allowed.includes(desired) && modelAllows(desired)) return { value: desired, note: null };
    const reason = !allowed.includes(desired)
      ? modelConstrained && modelOptions.includes(desired)
        ? `当前上游参考不支持 ${desired}`
        : (STANDARD_REF_MODES as readonly string[]).includes(desired)
          ? `当前模型不支持 ${desired}`
          : `${desired} 不是有效的参考方式`
      : `当前模型不支持 ${desired}`;
    const value = fallback();
    return { value, note: `${reason}，已用 ${value}` };
  }
  return { value: fallback(), note: null };
}

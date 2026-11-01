/**
 * 节点尺寸测量（纯函数）：实测值 > style 显式值 > 兜底猜测。
 *
 * 独立于任何布局模块：画布整理、组内布局、编组包围盒与拖拽几何都只用这一份
 * 口径，测量逻辑不寄居在布局模块里被反向依赖。
 */
import type { AnyNode } from "@/features/canvas/types";

/** 节点尺寸兜底（未测量到时的猜测值） */
const FALLBACK_WIDTH = 200;
const FALLBACK_HEIGHT = 120;

export interface Size {
  width: number;
  height: number;
}

/** 转正数，NaN / 0 / 负数一律视为无效值以走回退链 */
function toNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 取节点尺寸：实测值 > style 显式值 > 兜底猜测 */
export function measureNode(node: AnyNode): Size {
  return {
    width: toNumber(node.measured?.width) ?? toNumber(node.style?.width) ?? FALLBACK_WIDTH,
    height: toNumber(node.measured?.height) ?? toNumber(node.style?.height) ?? FALLBACK_HEIGHT,
  };
}

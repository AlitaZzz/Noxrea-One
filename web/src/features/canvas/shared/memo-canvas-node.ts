import type { ComponentType } from "react";
import { memo } from "react";

/**
 * 画布节点的渲染边界。
 *
 * React Flow 的节点位置由 NodeWrapper 以 transform 渲染；父节点移动（组拖动）
 * 时，`@xyflow/system` 会给每个成员节点写入新的 internals，并经 NodeWrapper 把
 * `positionAbsoluteX/Y` 注入节点组件。这两个 prop 不参与节点自身的渲染，但它们
 * 每帧都变 —— 默认浅比较下所有成员的整棵子树会随每一帧重渲染。
 *
 * 画布节点组件只消费 `id`/`data`/`selected` 等业务输入，位置变化一律由该边界
 * 拦截；需要实时位置的子组件（媒体优先级、LOD）自行订阅 React Flow store。
 */

const POSITION_PROPS: ReadonlySet<string> = new Set(["positionAbsoluteX", "positionAbsoluteY"]);

function canvasNodePropsEqual(prev: object, next: object): boolean {
  const prevProps = prev as Record<string, unknown>;
  const nextProps = next as Record<string, unknown>;
  const nextKeys = Object.keys(nextProps);
  if (nextKeys.length !== Object.keys(prevProps).length) return false;
  for (const key of nextKeys) {
    if (POSITION_PROPS.has(key)) continue;
    if (!Object.is(prevProps[key], nextProps[key])) return false;
  }
  return true;
}

/** 注册到 React Flow 的节点组件统一经此包装（见 nodes/canvas-node-types.ts）。 */
export function memoCanvasNode<P extends object>(component: ComponentType<P>): ComponentType<P> {
  return memo(component, canvasNodePropsEqual as (prev: P, next: P) => boolean);
}

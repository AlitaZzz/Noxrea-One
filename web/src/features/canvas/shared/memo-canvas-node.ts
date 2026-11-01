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
 * `selected` / `dragging` 同属运行时状态：选中描边由包装层类（`.selected`）驱动，
 * 节点组件不再读取它们。否则单次选中就要重渲染节点主体（实测单次 10–30ms、
 * Ctrl+A 191ms），而选中只改变包装层类与 CSS。需要这些状态的子树（缩放手柄、
 * 取消选中暂停等）自行经 hooks/use-node-selected 订阅。
 *
 * `zIndex` 是 React Flow 的选中抬升结果：`elevateNodesOnSelect`（默认开启）让
 * `internals.z = zIndex + (selected ? 1000 : 0)`，NodeWrapper 再把它作为 prop 注入。
 * 它只决定包装层堆叠顺序，不参与节点内容渲染；若不拦截，任何选中都会让全部
 * 选中节点重新渲染，抵消上面 `selected` 的拦截。
 *
 * 画布节点组件只消费 `id`/`data` 等业务输入，运行时 prop 变化一律由该边界拦截；
 * 需要实时位置/选中/拖拽状态的子组件自行订阅 React Flow / 画布 store。
 */

const RUNTIME_PROPS: ReadonlySet<string> = new Set([
  "positionAbsoluteX",
  "positionAbsoluteY",
  "selected",
  "dragging",
  "zIndex",
]);

function canvasNodePropsEqual(prev: object, next: object): boolean {
  const prevProps = prev as Record<string, unknown>;
  const nextProps = next as Record<string, unknown>;
  const nextKeys = Object.keys(nextProps);
  if (nextKeys.length !== Object.keys(prevProps).length) return false;
  for (const key of nextKeys) {
    if (RUNTIME_PROPS.has(key)) continue;
    if (!Object.is(prevProps[key], nextProps[key])) return false;
  }
  return true;
}

/** 注册到 React Flow 的节点组件统一经此包装（见 nodes/canvas-node-types.ts）。 */
export function memoCanvasNode<P extends object>(component: ComponentType<P>): ComponentType<P> {
  return memo(component, canvasNodePropsEqual as (prev: P, next: P) => boolean);
}

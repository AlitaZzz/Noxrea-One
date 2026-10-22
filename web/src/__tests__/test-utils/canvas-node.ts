/**
 * 单节点视图测试的公共脚手架。
 *
 * 节点视图测试只关心节点自身的交互与持久化写入，React Flow 注入的选中 /
 * 拖拽 / 连接等运行时字段全部固定为静止态；编辑动作链推进在 Promise 微任务
 * 上，统一用 flushMicrotasks 让测试观察到最终 onSuccess。
 */
import { act } from "@testing-library/react";
import type { ComponentProps, ElementType } from "react";

/**
 * 组装单个节点视图的最小 props（静止态）；props 类型由被渲染的节点组件收窄。
 *
 * 双重断言是刻意的：NodeProps 也声明了 React Flow 运行时注入、节点组件并不读取的
 * 字段（handle bounds 等），测试无法也不应构造它们——这里只提供静止态下被读取的
 * 子集，类型收窄交给调用方的 T。
 */
export function nodeViewProps<T extends ElementType>(
  id: string,
  type: string,
  data: unknown,
): ComponentProps<T> {
  return {
    id,
    type,
    data,
    selected: false,
    dragging: false,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
  } as unknown as ComponentProps<T>;
}

/**
 * 微任务轮次上限：编辑管线的每个 await 消耗一轮，实测最长链在 8 轮内收敛。
 * 这里不用 setTimeout 冲刷——部分用例在 fake timers 下调用本函数，宏任务不会执行。
 */
const MICROTASK_TURNS = 8;

/** 冲掉编辑动作链的微任务（客户端管线 → 状态更新 → 服务端兜底） */
export async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < MICROTASK_TURNS; i++) await Promise.resolve();
  });
}

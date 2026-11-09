"use client";

import { createContext, useContext } from "react";

/**
 * 画布输入门：页面浮层（inputBlocked）与画布内部编辑面板（modalOpen）合并后
 * 下发。默认 false，便于编辑面板等叶子组件在独立测试中挂载。
 */
const CanvasInputGateContext = createContext(false);

export function useCanvasInputBlocked(): boolean {
  return useContext(CanvasInputGateContext);
}

export default CanvasInputGateContext;

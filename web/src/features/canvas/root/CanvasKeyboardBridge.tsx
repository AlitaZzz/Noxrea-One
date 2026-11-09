"use client";

import { useCanvasKeyboard } from "@/features/canvas/hooks/use-canvas-keyboard";

/**
 * 画布快捷键的唯一挂载点。独立成叶组件：输入门变化只重渲染本组件，
 * 不把 CanvasSurface 拖入页面浮层开合的重渲染。
 */
export default function CanvasKeyboardBridge() {
  useCanvasKeyboard();
  return null;
}

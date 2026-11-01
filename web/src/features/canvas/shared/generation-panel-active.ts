/**
 * 生成面板的「当前可见」上下文。
 *
 * 生成面板宿主常驻后，面板隐藏（取消选中 / 切换目标 / 框选与拖动）只切显隐，
 * 面板内的 Tiptap 编辑器与 mention chip 不卸载。媒体元素（参考缩略图、chip 缩略图）
 * 必须在隐藏期间停止 URL 解析与 signed 地址的主动刷新，否则隐藏面板会继续订阅
 * 会话级定时器。媒体组件经该上下文自行退化为占位，重新可见时按缓存地址即时恢复。
 */
"use client";

import { createContext, useContext } from "react";

const GenerationPanelActiveContext = createContext(true);

export const GenerationPanelActiveProvider = GenerationPanelActiveContext.Provider;

/** 面板当前是否可见；不在面板内（默认 true）时媒体照常渲染。 */
export function useGenerationPanelActive(): boolean {
  return useContext(GenerationPanelActiveContext);
}

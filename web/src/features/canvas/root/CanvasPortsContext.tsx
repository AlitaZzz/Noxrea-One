"use client";

import { createContext, useContext } from "react";

import type { CanvasPorts } from "./contracts";

export const CanvasPortsContext = createContext<CanvasPorts | null>(null);

/** 画布内部组件获取页面注入的端口；缺失 Provider 属于装配错误，直接抛出。 */
export function useCanvasPorts(): CanvasPorts {
  const ports = useContext(CanvasPortsContext);
  if (!ports) throw new Error("useCanvasPorts must be used within CanvasRoot");
  return ports;
}

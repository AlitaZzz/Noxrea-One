"use client";

import { createContext, useContext } from "react";

export interface CanvasShell {
  /** 资源管理器开合由 CanvasRoot 持有；Surface 内的控制条只消费开关与动作。 */
  explorerOpen: boolean;
  toggleExplorer: () => void;
  /** Agent 抽屉由 CanvasRoot 挂载，Surface 只提供入口按钮。 */
  openAgent: () => void;
}

const CanvasShellContext = createContext<CanvasShell | null>(null);

export function useCanvasShell(): CanvasShell {
  const shell = useContext(CanvasShellContext);
  if (!shell) throw new Error("useCanvasShell must be used within CanvasRoot");
  return shell;
}

export default CanvasShellContext;

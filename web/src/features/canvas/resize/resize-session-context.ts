import { createContext, useContext } from "react";

import type { ResizeSession } from "./resize-session";

export const ResizeSessionContext = createContext<ResizeSession | null>(null);

/** 缩放手柄取当前画布的会话；必须在 ResizeSessionContext 内渲染 */
export function useResizeSession(): ResizeSession {
  const session = useContext(ResizeSessionContext);
  if (!session) {
    throw new Error("useResizeSession 必须在 ResizeSessionContext 内使用");
  }
  return session;
}

/**
 * 画布节点动作事件（CANVAS_NODE_ACTION）的统一派发通道。
 * 面板/工具栏侧派发，节点侧监听后按 detail.action switch 处理；
 * detail 形状固定为 { nodeId, action, ...extra }。
 */
import { EventNames } from "@/lib/constants";

export function dispatchNodeAction(nodeId: string, action: string, extra?: Record<string, unknown>) {
  window.dispatchEvent(
    new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId, action, ...extra } })
  );
}

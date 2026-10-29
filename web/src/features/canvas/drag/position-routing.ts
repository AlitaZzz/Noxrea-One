/**
 * 位置帧分流（规则 1.2、1.4）：React Flow 的位置变更按 `dragging` 分成两类。
 *
 * - 拖动过程帧（`dragging === true`）→ 会话预览：只写 DOM，不写受控 store，
 *   因此拖动期不触发 markDirty、不重渲染画布；
 * - 终态帧（其余位置变更）→ 会话提交：按吸附后的最终几何一次写 store 并落库；
 *   会话未激活（无拖动开始的程序化位置变更）→ 直接写入口径。
 *
 * 该函数是拖动期「位置帧不落库」的唯一分流点：调用方传入的 `applyDirect`
 * 是位置写入触发 markDirty 的唯一路径，过程帧永不经过它。
 */
import type { PositionFrame } from "@/features/canvas/shared/node-positions";

/** 位置帧接收方：DragPreviewSession 满足该接口 */
export interface PositionFrameSink {
  isActive(): boolean;
  preview(frames: PositionFrame[]): void;
  commit(frames: PositionFrame[]): void;
}

/** 位置变更的可分流子集：React Flow 在仅切换 dragging 状态时可能缺省 position */
export interface PositionFrameChange {
  id: string;
  position?: { x: number; y: number };
  dragging?: boolean;
}

export function routePositionFrames(
  changes: PositionFrameChange[],
  session: PositionFrameSink,
  applyDirect: (frames: PositionFrame[]) => void,
): void {
  const dragFrames: PositionFrame[] = [];
  const settledFrames: PositionFrame[] = [];
  for (const change of changes) {
    if (!change.position) continue;
    const frame = { id: change.id, position: change.position };
    if (change.dragging === true) dragFrames.push(frame);
    else settledFrames.push(frame);
  }
  if (dragFrames.length > 0) {
    if (session.isActive()) session.preview(dragFrames);
    else applyDirect(dragFrames);
  }
  if (settledFrames.length > 0) {
    if (session.isActive()) session.commit(settledFrames);
    else applyDirect(settledFrames);
  }
}

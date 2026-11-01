/**
 * 可合成的青柠流光描边（specs/canvas-selection-chrome-scheduling.md 5.3）。
 *
 * 外层只保留静态的 1.5px 环（mask 挖空中间），内层承载静态 conic-gradient，
 * 动画只旋转内层的 transform，交给合成器执行，不再每帧触发主线程重算/重绘。
 * 三处共用：生成浮层（className="generation-border"）、连接目标（.node-body
 * 的 node-connect-ok 状态类由 connection-tilt 命令式控制显隐）、Agent 入口按钮。
 */
import { memo } from "react";

export default memo(function LimeRing({ className }: { className?: string }) {
  return (
    <span className={`lime-ring${className ? ` ${className}` : ""}`} aria-hidden>
      <span className="lime-ring__spin" />
    </span>
  );
});

/**
 * 连线拖动时的目标节点反馈（卡片式 tilt + 连接可行性提示）——命令式 DOM 写入版。
 *
 * 两个互斥状态，由驱动方（ConnectionFlowLine）按磁吸/悬停命中判定：
 * - ok：节点可连——整卡朝指针方位轻微 3D 倾斜（origin 固定在节点中心，指针偏离中心
 *   越多倾得越多，边缘达到最大角），节点 body 叠加 agent 按钮同款流动描边（.node-connect-ok）；
 * - blocked：节点不可连——整卡保持平整，body 覆盖毛玻璃蒙层（.node-connect-no）表达"此处不可连"。
 * 倾斜目标是 .node-tilt（整卡），描边/蒙层目标是 .node-body（不含标题栏）。
 *
 * 刻意不走 React/zustand：逐帧 setState 会让目标节点（ImageNode 等重组件）
 * 以 60Hz 完整重渲染；直接写目标元素的 style/classList 全程零重渲染，
 * 进出场与逐帧平滑仍由 .node-tilt 的 CSS transition 承担。
 * 不要把 transform-origin 移到指针处——转轴钉在角上叠加最大角度时，
 * 远角会缩到 0.7 倍，看起来像扭坏而非倾斜。
 */
"use client";

/** 指针在节点边缘时的倾斜角（度）：中心为 0，线性增大到边缘 */
const EDGE_TILT_DEG = 10;
/** 透视距离：与节点尺寸（~600px）同量级，保证梯形收敛清晰 */
const PERSPECTIVE_PX = 800;

/** 可连目标：agent 按钮同款流动描边（见 globals.css 连线反馈分区） */
const CLASS_CONNECT_OK = "node-connect-ok";
/** 不可连目标：毛玻璃蒙层 */
const CLASS_CONNECT_NO = "node-connect-no";

export type ConnectionFeedback = "ok" | "blocked";

interface TiltTarget {
  id: string;
  box: { x: number; y: number; width: number; height: number };
}

let activeEl: HTMLElement | null = null; // 倾斜目标 .node-tilt（整卡）
let activeBodyEl: HTMLElement | null = null; // 描边/蒙层目标 .node-body（不含标题栏）
let activeNodeId: string | null = null;

/** 节点的倾斜容器：React Flow 节点包裹层带 data-id，倾斜目标是其内层 .node-tilt */
function tiltEl(id: string): HTMLElement | null {
  return document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] .node-tilt`);
}

function reset() {
  if (activeEl) activeEl.style.transform = "";
  activeBodyEl?.classList.remove(CLASS_CONNECT_OK, CLASS_CONNECT_NO);
  activeEl = null;
  activeBodyEl = null;
  activeNodeId = null;
}

/** 清除全部反馈（指针离开所有节点 / 连线结束）；目标元素已卸载时静默 */
export function clearConnectionTilt() {
  reset();
}

/** 应用反馈：目标切换时先复位上一个节点，再写入新节点的 transform 与状态类 */
export function applyConnectionTilt(
  target: TiltTarget,
  point: { x: number; y: number },
  feedback: ConnectionFeedback
) {
  const { width, height } = target.box;
  if (width <= 0 || height <= 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    clearConnectionTilt();
    return;
  }
  if (activeNodeId !== target.id) {
    reset();
    activeNodeId = target.id;
  }
  // 元素可能晚于首次命中存在或已脱离文档（HMR / 重挂载），缓存失效时重查
  if (!activeEl || !activeEl.isConnected) {
    activeEl = tiltEl(target.id);
    activeBodyEl = activeEl?.querySelector(":scope .node-body") ?? null;
  }
  if (!activeEl) return;

  activeBodyEl?.classList.toggle(CLASS_CONNECT_OK, feedback === "ok");
  activeBodyEl?.classList.toggle(CLASS_CONNECT_NO, feedback === "blocked");
  // 不可连的节点保持平整，只给毛玻璃（同节点从 ok 切来时还要清掉残留倾斜）
  if (feedback === "blocked") {
    activeEl.style.transform = "";
    return;
  }

  // 归一化到 -1..1（中心 0，边缘 ±1），越界钳制——磁吸时指针可在节点外，钳到边缘取最大角
  const nx = Math.max(-1, Math.min(1, ((point.x - target.box.x) / width) * 2 - 1));
  const ny = Math.max(-1, Math.min(1, ((point.y - target.box.y) / height) * 2 - 1));
  activeEl.style.transform =
    `perspective(${PERSPECTIVE_PX}px) rotateX(${(-ny * EDGE_TILT_DEG).toFixed(3)}deg) rotateY(${(nx * EDGE_TILT_DEG).toFixed(3)}deg)`;
}

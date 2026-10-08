/**
 * 图像与媒体处理工具集（纯计算与本地加工，不含上传与 store 操作）。
 * 提供显示尺寸换算、媒体自然尺寸读取、Canvas 导出，
 * 以及派生节点的网格布局计算。
 *
 * 上传与落库统一走 features/canvas/upload 的上传管道，本模块不再涉及。
 */
"use client";

import { DEFAULT_NODE_WIDTH, NODE_DISPLAY_MAX, NODE_TITLE_HEIGHT, VIDEO_FALLBACK_HEIGHT, VIDEO_FALLBACK_WIDTH } from "@/lib/constants";

/**
 * 纯函数：计算 NODE_DISPLAY_MAX 等比缩放后的显示尺寸（长边约束）。
 *
 * 返回 { scale, displayW, displayH }，不含标题栏高度（titleH 由调用方酌情添加）。
 *
 * @param naturalW  图片自然宽度
 * @param naturalH  图片自然高度
 * @param max       可选，长边最大像素值，默认 NODE_DISPLAY_MAX(600)
 */
export function computeThumbScale(
  naturalW: number,
  naturalH: number,
  max?: number,
): { scale: number; displayW: number; displayH: number } {
  const limit = max ?? NODE_DISPLAY_MAX;
  const longSide = Math.max(naturalW, naturalH);
  const scale = longSide > limit ? limit / longSide : 1;
  return {
    scale,
    displayW: Math.round(naturalW * scale),
    displayH: Math.round(naturalH * scale),
  };
}

/**
 * 计算节点的显示尺寸（等比缩放 + 标题栏高度）。
 *
 * 所有创建/更新图片/视频节点的路径应统一使用此函数，
 * 避免遗漏 titleH 导致的图片区域压缩。
 */
export function computeNodeSize(naturalW: number, naturalH: number): { width: number; height: number } {
  const { displayW, displayH } = computeThumbScale(naturalW, naturalH);
  return { width: displayW, height: displayH + NODE_TITLE_HEIGHT };
}

/**
 * 创建 Canvas -> 执行绘制 -> 导出 Blob。
 *
 * 提取的是 createElement("canvas") + getContext("2d") + toBlob 的公共管线，
 * 具体的绘制逻辑由 draw 回调处理，不强求统一。
 *
 * @param width   canvas 宽度
 * @param height  canvas 高度
 * @param draw    绘制回调，接收 (ctx, canvas)
 * @param type    导出 MIME 类型，默认 "image/png"
 * @param quality 导出质量（0-1），仅对 image/jpeg 生效
 */
export function canvasToBlob(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void,
  type?: string,
  quality?: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  draw(ctx, canvas);
  // toBlob 在宽高为 0、画布超出浏览器上限或内存不足时回调 null；
  // 此前用 b! 把 null 断言成 Blob 后 resolve，下游会拿到 null 继续上传空文件。
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvasToBlob: encode failed"))),
      type || "image/png",
      quality,
    ),
  );
}

/**
 * 异步加载图片/视频的真实显示尺寸。
 *
 * 适用于需要在节点创建前获取媒体原始宽高的场景。
 *
 * @param url      媒体 URL
 * @param isVideo  是否为视频（影响加载方式）
 * @returns { w, h } 宽高，失败时返回 0
 */
/**
 * 同 loadMediaDimensions，额外带超时：
 * 个别媒体的元数据可能既不触发 load 也不触发 error（编码异常、连接挂起），
 * 没有超时会让上传 / 生成结果回填一直停在占位状态。
 */
export function loadMediaDimensions(url: string, isVideo: boolean, timeoutMs = 10000): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { w: number; h: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done({ w: 0, h: 0 }), timeoutMs);

    if (isVideo) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => done({ w: v.videoWidth || VIDEO_FALLBACK_WIDTH, h: v.videoHeight || VIDEO_FALLBACK_HEIGHT });
      v.onerror = () => done({ w: 0, h: 0 });
      v.src = url;
    } else {
      const img = new window.Image();
      img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => done({ w: 0, h: 0 });
      img.src = url;
    }
  });
}

// ── 派生节点网格布局 ──
// 宫格切分、全景多视角截图等批量派生节点统一使用此布局，
// 保证各处"源节点右侧网格"的基准点与步进逻辑一致。

/** 派生节点相对源节点的水平基准间隙（px）。数值与 LAYOUT_GAP 相同但语义独立：
 *  这是源节点→派生网格的专有间距，不随整理/粘贴间距调整 */
export const DERIVED_BASE_GAP_X = 60;
/** 相邻派生节点之间的间隙（px） */
const DERIVED_CELL_GAP = 12;
/** 单产物派生宫格的列数（创作/裁剪/抽帧等逐次派生按行优先填入） */
export const DERIVED_SLOT_COLS = 3;
/** 宫格找空位的扫描上限（槽位数），密集画布兜底取最后一个候选，防死循环 */
const DERIVED_SLOT_SCAN_LIMIT = 200;

export interface DerivedGridLayout {
  baseX: number;
  baseY: number;
  stepX: number;
  stepY: number;
  cols: number;
  displayW: number;
  displayH: number;
}

/** 落位计算用的节点最小形状：位置 + 可选显示尺寸 */
export interface LayoutNode {
  position: { x: number; y: number };
  style?: { width?: number | string; height?: number | string };
}

/** 节点显示矩形：style 宽高缺失、非数字或非正值时按兜底尺寸处理
 *  （xyflow 类型允许 string；0/NaN 尺寸无法参与落位与碰撞计算） */
export function nodeRectOf(
  node: LayoutNode,
  fallback: { width: number; height: number } = { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_WIDTH },
): { x: number; y: number; width: number; height: number } {
  const w = typeof node.style?.width === "number" && node.style.width > 0 ? node.style.width : fallback.width;
  const h = typeof node.style?.height === "number" && node.style.height > 0 ? node.style.height : fallback.height;
  return { x: node.position.x, y: node.position.y, width: w, height: h };
}

/** 矩形是否与任一节点重叠（边接触不算重叠） */
function rectOverlapsNodes(
  nodes: LayoutNode[],
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  return nodes.some((n) => {
    const r = nodeRectOf(n);
    return (
      rect.x < r.x + r.width &&
      rect.x + rect.width > r.x &&
      rect.y < r.y + r.height &&
      rect.y + rect.height > r.y
    );
  });
}

/** 派生宫格基准点：源节点右边缘 + 水平间隙（源节点可空时以原点为基准） */
function derivedGridBase(source: LayoutNode | undefined): { x: number; y: number } {
  if (!source) return { x: DEFAULT_NODE_WIDTH + DERIVED_BASE_GAP_X, y: 0 };
  const rect = nodeRectOf(source);
  return { x: rect.x + rect.width + DERIVED_BASE_GAP_X, y: rect.y };
}

/**
 * 计算派生节点网格布局。
 *
 * 基准点 = 源节点右侧 + 60px；水平步进 = 单格显示宽度 + 间隙；
 * 垂直步进 = 单格显示高度 + 标题栏(NODE_TITLE_HEIGHT) + 间隙，避免下一行压住 title。
 * 宫格切分、全景多视角截图等批量派生节点统一通过此函数计算位置，
 * 保证在画布上排列紧凑整齐且各处逻辑一致。
 *
 * @param sourceNode    源节点（用于定位网格基准点，可为空）
 * @param cellNaturalW  单个派生节点的自然宽度
 * @param cellNaturalH  单个派生节点的自然高度
 * @param cols          网格每行放置的节点数
 */
export function computeDerivedGrid(
  sourceNode: LayoutNode | undefined,
  cellNaturalW: number,
  cellNaturalH: number,
  cols: number,
): DerivedGridLayout {
  const { displayW, displayH } = computeThumbScale(cellNaturalW, cellNaturalH);
  const base = derivedGridBase(sourceNode);
  return {
    baseX: base.x,
    baseY: base.y,
    stepX: displayW + DERIVED_CELL_GAP,
    // 纵向需计入标题栏高度，避免下一行节点压住上一行的 title
    stepY: displayH + NODE_TITLE_HEIGHT + DERIVED_CELL_GAP,
    cols,
    displayW,
    displayH,
  };
}

/**
 * 根据网格布局与索引计算节点位置（行优先，从左到右）。
 *
 * @param layout computeDerivedGrid 的返回值
 * @param index  节点在批量创建顺序中的索引（0 起）
 */
export function gridPositionAt(layout: DerivedGridLayout, index: number): { x: number; y: number } {
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return { x: layout.baseX + col * layout.stepX, y: layout.baseY + row * layout.stepY };
}

/**
 * 单产物派生宫格找空位：从源节点右侧基准点开始，按行优先宫格扫描
 * （列数 DERIVED_SLOT_COLS），返回第一个与新节点矩形不重叠的槽位。
 *
 * 槽位步进用新节点自己的显示尺寸，因此重复派生同尺寸产物自然排成宫格、
 * 不同尺寸产物也不会互相压住；目标区域被任何节点占用（含用户手动摆放的）
 * 则顺延到下一空格，永不重叠。扫描超过上限时取最后一个候选兜底。
 *
 * @param nodes  需要避开的节点（现有画布节点，可含同批已落位的节点）
 * @param source 源节点（决定基准点，可空）
 * @param size   新节点的显示尺寸
 */
export function findDerivedSlot(
  nodes: LayoutNode[],
  source: LayoutNode | undefined,
  size: { width: number; height: number },
): { x: number; y: number } {
  const base = derivedGridBase(source);
  const stepX = size.width + DERIVED_CELL_GAP;
  const stepY = size.height + DERIVED_CELL_GAP;
  let fallback = base;
  for (let i = 0; i < DERIVED_SLOT_SCAN_LIMIT; i++) {
    const col = i % DERIVED_SLOT_COLS;
    const row = Math.floor(i / DERIVED_SLOT_COLS);
    const pos = { x: base.x + col * stepX, y: base.y + row * stepY };
    fallback = pos;
    if (!rectOverlapsNodes(nodes, { ...pos, ...size })) return pos;
  }
  return fallback;
}

/**
 * 批量派生整体找空位：把整批网格的包围盒当成一个大矩形，从基准点按
 * 网格步进扫描，返回第一个整批无碰撞的起点（行优先）。
 *
 * 整批内部相对布局（computeDerivedGrid + gridPositionAt）保持不变，
 * 仅整体平移到空区域——重复宫格切分时第二批自动排到第一批下方/右侧，
 * 不压已有内容。
 *
 * @param nodes  需要避开的节点（现有画布节点）
 * @param layout computeDerivedGrid 的返回值
 * @param count  本批节点总数
 * @returns 无碰撞的网格起点（对应 layout.baseX / baseY 的替换值）
 */
export function findDerivedBatchOrigin(
  nodes: LayoutNode[],
  layout: DerivedGridLayout,
  count: number,
): { x: number; y: number } {
  const rows = Math.max(1, Math.ceil(count / layout.cols));
  const bbox = {
    width: layout.cols * layout.stepX - DERIVED_CELL_GAP,
    height: rows * layout.stepY - DERIVED_CELL_GAP,
  };
  const base = { x: layout.baseX, y: layout.baseY };
  let fallback = base;
  for (let i = 0; i < DERIVED_SLOT_SCAN_LIMIT; i++) {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const origin = { x: base.x + col * layout.stepX, y: base.y + row * layout.stepY };
    fallback = origin;
    if (!rectOverlapsNodes(nodes, { ...origin, ...bbox })) return origin;
  }
  return fallback;
}

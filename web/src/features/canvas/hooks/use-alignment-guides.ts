/**
 * 节点间对齐辅助线计算。
 *
 * 当 snapToGrid 开启并拖拽节点时，计算拖拽节点与画布上其他节点的
 * 边界/中心对齐关系，生成吸附偏移量和辅助线数据。
 */

export interface AlignmentGuide {
  type: "horizontal" | "vertical";
  /** 对齐线在画布坐标中的位置（垂直线=X，水平线=Y） */
  position: number;
  /** 垂直线段在 Y 轴的起点 */
  start: number;
  /** 垂直线段在 Y 轴的终点 */
  end: number;
}

export interface AlignmentResult {
  /** X 轴吸附后的节点位置，null 表示无对齐 */
  snapX: number | null;
  /** Y 轴吸附后的节点位置，null 表示无对齐 */
  snapY: number | null;
  /** 需要绘制的辅助线列表 */
  guides: AlignmentGuide[];
}

interface NodeBounds {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
}

/**
 * 计算拖拽节点的对齐吸附偏移量和辅助线。
 *
 * @param draggingNode 拖拽中的节点信息
 * @param allNodes 画布上所有节点（含拖拽节点本身）
 * @param threshold 吸附阈值（px），默认 5
 * @returns 对齐结果
 */
/**
 * 判断 other 节点是否可能与拖拽节点产生对齐吸附。
 *
 * 吸附成立需某一坐标（左/中/右 或 上/中/下）相距 < threshold，且边到边
 * 吸附额外允许 gap。因此对 X/Y 轴分别用"矩形区间 + gap + threshold"外扩的
 * 保守判定即可，空间上远在阈值之外的节点绝不会触发吸附，可直接跳过，
 * 从而把每帧 O(n) 的全量比对降为仅邻近节点子集。
 */
export function isAlignmentCandidate(
  draggingNode: NodeBounds,
  other: NodeBounds,
  threshold: number,
  gap: number,
): boolean {
  const dMinX = draggingNode.position.x;
  const dMaxX = dMinX + draggingNode.width;
  const dMinY = draggingNode.position.y;
  const dMaxY = dMinY + draggingNode.height;

  const oMinX = other.position.x;
  const oMaxX = oMinX + other.width;
  const oMinY = other.position.y;
  const oMaxY = oMinY + other.height;

  const pad = threshold + gap;
  const nearX = dMinX - pad <= oMaxX && oMinX <= dMaxX + pad;
  const nearY = dMinY - pad <= oMaxY && oMinY <= dMaxY + pad;
  return nearX || nearY;
}

export function computeAlignment(
  draggingNode: NodeBounds,
  allNodes: NodeBounds[],
  threshold = 5,
  gap = 0,
): AlignmentResult {
  const guides: AlignmentGuide[] = [];
  let bestSnapX: number | null = null;
  let bestSnapY: number | null = null;
  let bestDeltaX = threshold + 1;
  let bestDeltaY = threshold + 1;

  const dw = draggingNode.width;
  const dh = draggingNode.height;
  const dx = draggingNode.position.x;
  const dy = draggingNode.position.y;

  // 拖拽节点的 6 个关键坐标
  const dLeft = dx;
  const dCenterX = dx + dw / 2;
  const dRight = dx + dw;
  const dTop = dy;
  const dCenterY = dy + dh / 2;
  const dBottom = dy + dh;

  for (const other of allNodes) {
    if (other.id === draggingNode.id) continue;
    // 空间分区：跳过远在吸附阈值之外的节点，大幅降低大画布下的每帧成本
    if (!isAlignmentCandidate(draggingNode, other, threshold, gap)) continue;

    const ow = other.width;
    const oh = other.height;
    const ox = other.position.x;
    const oy = other.position.y;

    const oLeft = ox;
    const oCenterX = ox + ow / 2;
    const oRight = ox + ow;
    const oTop = oy;
    const oCenterY = oy + oh / 2;
    const oBottom = oy + oh;

    // ---- 垂直对齐（X轴） ----
    const vertChecks = [
      { dVal: dLeft, oVal: oLeft, offset: 0 },
      { dVal: dCenterX, oVal: oCenterX, offset: dw / 2 },
      { dVal: dRight, oVal: oRight, offset: dw },
      // 吸附到对方的中点我单方面也加入（对一边中另一边边的对齐）
      { dVal: dLeft, oVal: oCenterX, offset: 0 },
      { dVal: dCenterX, oVal: oLeft, offset: dw / 2 },
      { dVal: dCenterX, oVal: oRight, offset: dw / 2 },
      { dVal: dRight, oVal: oCenterX, offset: dw },
      // 边到边的交叉对齐（保持 gap 间距）
      { dVal: dLeft, oVal: oRight + gap, offset: 0 },
      { dVal: dRight, oVal: oLeft - gap, offset: dw },
    ];

    for (const { dVal, oVal, offset } of vertChecks) {
      const delta = Math.abs(dVal - oVal);
      if (delta < threshold) {
        if (delta < bestDeltaX) {
          bestDeltaX = delta;
          bestSnapX = oVal - offset;
        }
        guides.push({
          type: "vertical",
          position: oVal,
          start: Math.min(dTop, oTop),
          end: Math.max(dBottom, oBottom),
        });
      }
    }

    // ---- 水平对齐（Y轴） ----
    const horizChecks = [
      { dVal: dTop, oVal: oTop, offset: 0 },
      { dVal: dCenterY, oVal: oCenterY, offset: dh / 2 },
      { dVal: dBottom, oVal: oBottom, offset: dh },
      // 到对方中点
      { dVal: dTop, oVal: oCenterY, offset: 0 },
      { dVal: dCenterY, oVal: oTop, offset: dh / 2 },
      { dVal: dCenterY, oVal: oBottom, offset: dh / 2 },
      { dVal: dBottom, oVal: oCenterY, offset: dh },
      // 边到边的交叉（保持 gap 间距）
      { dVal: dTop, oVal: oBottom + gap, offset: 0 },
      { dVal: dBottom, oVal: oTop - gap, offset: dh },
    ];

    for (const { dVal, oVal, offset } of horizChecks) {
      const delta = Math.abs(dVal - oVal);
      if (delta < threshold) {
        if (delta < bestDeltaY) {
          bestDeltaY = delta;
          bestSnapY = oVal - offset;
        }
        guides.push({
          type: "horizontal",
          position: oVal,
          start: Math.min(dLeft, oLeft),
          end: Math.max(dRight, oRight),
        });
      }
    }
  }

  // 去重辅助线（同一位置的同一类型线只保留一条）
  const dedupedGuides = guides.filter(
    (g, i, arr) =>
      arr.findIndex(
        (x) => x.type === g.type && Math.abs(x.position - g.position) < 0.5,
      ) === i,
  );

  return {
    snapX: bestSnapX,
    snapY: bestSnapY,
    guides: dedupedGuides,
  };
}

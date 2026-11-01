/**
 * 读序（视觉阅读顺序）：全库唯一实现。
 *
 * 画布整理与组内布局共用同一口径——按垂直中线分带，同一横带内按 x 升序。
 * 带高取平均高度的一半：既容得下同一行内的轻微错位，又不会把上下两行并成一行。
 *
 * 分带基准是中线而非顶边：布局的跨轴对齐都是居中（宫格行内、水平/垂直跨轴、
 * 分层列内），同一行/列的成员中线重合。若按顶边分带，高矮混排时矮成员的顶边
 * 被居中下移，会被判成另一行，下一次读序随之改变填充顺序——宫格与水平布局
 * 由此在两次执行间来回换位。中线分带下，「居中排出的结果」再次读序恰好还原
 * 排布顺序，布局因此幂等。
 *
 * 排序稳定：中线相同保持入参顺序，带内 x 相同保持中线顺序（即自上而下），
 * 因此「创建顺序」只在几何完全重合时才成为可见顺序。
 */

/** 读序分带的最小带高，防止元素极矮时把所有元素并成一带 */
const MIN_BAND_HEIGHT = 60;

/** 读序所需的最小几何信息；布局块、组内成员盒子都可直接传入 */
export interface ReadingBox {
  x: number;
  y: number;
  height: number;
}

const centerY = (item: ReadingBox): number => item.y + item.height / 2;

export function sortBoxesByReading<T extends ReadingBox>(items: readonly T[]): T[] {
  if (items.length <= 1) return [...items];

  const avgHeight = items.reduce((sum, item) => sum + item.height, 0) / items.length;
  const bandHeight = Math.max(MIN_BAND_HEIGHT, avgHeight / 2);

  const byCenterY = [...items].sort((a, b) => centerY(a) - centerY(b));
  const bands: T[][] = [];
  let band: T[] = [];
  let bandCenter = 0;

  for (const item of byCenterY) {
    if (band.length === 0) {
      band = [item];
      bandCenter = centerY(item);
      continue;
    }
    if (centerY(item) - bandCenter < bandHeight) {
      band.push(item);
    } else {
      bands.push(band);
      band = [item];
      bandCenter = centerY(item);
    }
  }
  if (band.length > 0) bands.push(band);

  return bands.flatMap((b) => [...b].sort((a, c) => a.x - c.x));
}

/**
 * 比例选择器的可视化图标（宽高比小方框）。
 * 用于生成面板中展示所选宽高比（如 16:9、1:1）。
 */
export function RatioIcon({ ratio }: { ratio: string; active?: boolean }) {
  const [w, h] = ratio.split(":").map(Number);
  const maxDim = 14;
  const boxW = Math.max(3, Math.round(maxDim * Math.min(1, w / Math.max(w, h))));
  const boxH = Math.max(3, Math.round(maxDim * Math.min(1, h / Math.max(w, h))));
  return (
    <span className="inline-flex items-center justify-center" style={{ width: 17, height: 17, marginRight: 3, flexShrink: 0 }}>
      <span className="rounded-[2px]" style={{ width: boxW, height: boxH, border: `1.5px solid currentColor` }} />
    </span>
  );
}

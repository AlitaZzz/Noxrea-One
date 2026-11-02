/**
 * 离屏文本测量。canvas 的 `measureText` 与 DOM 排版共用同一字形缓存，
 * 因此这里既用于量宽，也用于提前完成字形 shaping（见 prompt-shaping-prewarm）。
 */

let canvasContext: CanvasRenderingContext2D | null = null;

/** 复用的离屏 2D 上下文；非浏览器环境返回 null。 */
export function getTextMeasureContext(): CanvasRenderingContext2D | null {
  if (canvasContext) return canvasContext;
  if (typeof document === "undefined") return null;
  canvasContext = document.createElement("canvas").getContext("2d");
  return canvasContext;
}

/** 计算样式中的字体简写，保证 canvas 测量与 DOM 排版使用同一字体。 */
export function fontStringOf(style: CSSStyleDeclaration): string {
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

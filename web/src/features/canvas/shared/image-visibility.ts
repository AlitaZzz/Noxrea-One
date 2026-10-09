const MULTI_IMAGE_GAP = 8;

export type ImagePlacement = { column?: number; row?: number; stackDepth?: number };
type Rect = { x: number; y: number; width: number; height: number };

export function layoutMultiImages(urls: string[], mainUrl: string): ImagePlacement[] {
  let remaining = 0;
  return urls.map((url) => {
    if (url === mainUrl) return {};
    const index = remaining++;
    return { column: (index + 1) % 2, row: 0 - Math.floor((index + 1) / 2) };
  });
}

export function imagePlacementStyle({ column = 0, row = 0, stackDepth = 0 }: ImagePlacement) {
  if (stackDepth) {
    return {
      left: `${stackDepth * 12}px`,
      top: `${stackDepth * 4}px`,
      transform: `scale(${1 - stackDepth * 0.035}) rotate(${stackDepth * 2.5}deg)`,
      transformOrigin: "center center",
    };
  }
  return {
    left: column ? `calc(${column * 100}% + ${column * MULTI_IMAGE_GAP}px)` : "0px",
    top: row ? `calc(${row * 100}% + ${row * MULTI_IMAGE_GAP}px)` : "0px",
  };
}

/** Enclose the same transformed card used by the multi-image presentation. */
export function placedImageRect(body: Rect, { column = 0, row = 0, stackDepth = 0 }: ImagePlacement): Rect {
  const scale = 1 - stackDepth * 0.035;
  const angle = stackDepth * 2.5 * Math.PI / 180;
  const width = scale * (body.width * Math.abs(Math.cos(angle)) + body.height * Math.abs(Math.sin(angle)));
  const height = scale * (body.width * Math.abs(Math.sin(angle)) + body.height * Math.abs(Math.cos(angle)));
  return {
    x: body.x + column * (body.width + MULTI_IMAGE_GAP) + stackDepth * 12 + (body.width - width) / 2,
    y: body.y + row * (body.height + MULTI_IMAGE_GAP) + stackDepth * 4 + (body.height - height) / 2,
    width,
    height,
  };
}

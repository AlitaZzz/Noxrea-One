import type { AssetItem } from "./types";

/** 触发浏览器下载单个素材（同源直链）。 */
export function downloadAsset(asset: Pick<AssetItem, "sourceUrl" | "name">) {
  if (!asset.sourceUrl) return;
  const a = document.createElement("a");
  a.href = asset.sourceUrl;
  a.download = asset.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

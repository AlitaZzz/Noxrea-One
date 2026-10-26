import { resolveMediaUrl } from "@/lib/file-access";

/**
 * 解析并加载托管媒体位图（specs/storage-signed-direct-delivery.md 规则 3.6 的非元素形态）。
 *
 * 命令式消费方（编辑烘焙、切图、全景截图、复制图片、机位落画布）需要的是「此刻」的
 * 像素，不是挂载时的地址：长驻节点的签名可能早已过期，所以地址在调用时现取。
 * 元素加载失败（过期 / 403）按规则 3.6 重新描述一次再试，仍失败才上抛由调用方进入
 * 失败态；描述本身失败不触发这次刷新（重新加载同一个失败结果没有意义）。
 *
 * 只有 `signed` 地址值得重新描述：`stream` / 外部地址重解析只会得到同一地址，
 * 重载同一失败地址没有意义——与元素形态一致（`retrySigned` 对它们返回 `null`）。
 */
export async function loadMediaImage(value: string): Promise<HTMLImageElement> {
  const first = await resolveMediaUrl(value);
  try {
    return await loadImageElement(first.url);
  } catch (error) {
    if (first.delivery !== "signed") throw error;
    const refreshed = await resolveMediaUrl(value, { forceRefresh: true });
    return loadImageElement(refreshed.url);
  }
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    // 读像素（canvas 烘焙 / 复制）必须带凭据模式；同源与已配置 CORS 的对象存储均适用
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("media image load failed"));
    img.src = url;
  });
}

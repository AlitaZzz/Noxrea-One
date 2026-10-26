"use client";

/**
 * 访问地址失败的整幅遮罩（specs/storage-signed-direct-delivery.md 规则 3.6）。
 *
 * 覆盖型编辑器（标注 / 裁剪 / 全景）在描述失败时没有底图可操作：遮罩的定位、
 * z-index 与底色属于同一视觉约定，集中在这里，面板只决定「失败时是否盖住自己」。
 * 重试入口由 `MediaAccessError` 提供（走 `refresh` 强制重新描述）。
 */
import { MediaAccessError } from "./MediaAccessError";

interface Props {
  /** 强制重新描述访问地址；由 `useFileAccessUrl().refresh` 提供 */
  onRetry: () => void;
}

export function MediaAccessOverlay({ onRetry }: Props) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/85">
      <MediaAccessError onRetry={onRetry} />
    </div>
  );
}

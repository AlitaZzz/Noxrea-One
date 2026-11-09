"use client";

/**
 * 访问地址失败态（specs/storage-signed-direct-delivery.md 规则 3.6 / 异常边界）。
 *
 * 两类消费方共用：命令式消费方（裁剪 / 标注 / 全景 / 打光 / 多角度 / 切图 / 音频
 * 截取）与「媒体即内容」的展示点。它们都要先拿到最终地址才能工作，描述本身失败时
 * 没有 `<img onError>` 可挂——规则 3.6 的元素级自动重试覆盖不到，失败态必须自带
 * 手动重试入口，否则表现为一片空白 / 永久加载中。
 *
 * 重试走 `refresh`（强制重新描述），不用 `retrySigned`——后者只在已拿到 signed 地址、
 * 且元素加载失败时才有意义；描述本身失败时 `retrySigned` 按设计返回 `null`
 * （规则 3.6 的闩锁语义），拿它当重试入口只会空转。
 */
import { useTranslation } from "react-i18next";

import { ReloadOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";

interface Props {
  /** 重新描述访问地址；由 `useFileAccessUrl().refresh` 提供 */
  onRetry: () => void;
  /** 紧凑布局（浮层内的小块占位）；缺省铺满容器 */
  compact?: boolean;
}

export function MediaAccessError({ onRetry, compact = false }: Props) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={
        compact
          // 重试入口必须自行恢复指针事件：调用方可能把预览容器设为 pointer-events-none
          ? "pointer-events-auto flex flex-col items-center justify-center gap-2 rounded-md bg-black/65 px-3 py-2 text-center"
          : "pointer-events-auto flex h-full w-full flex-col items-center justify-center gap-3 p-4 text-center"
      }
    >
      <span className={compact ? "text-xs text-white/85" : "text-sm text-muted-foreground"}>
        {t("media.previewLoadFailed")}
      </span>
      <Button
        type="button"
        size={compact ? "sm" : "default"}
        variant="secondary"
        onClick={onRetry}
      >
        <ReloadOutlined />
        {t("media.retry")}
      </Button>
    </div>
  );
}

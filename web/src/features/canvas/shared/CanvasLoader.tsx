/**
 * 画布加载状态。
 * failed 时在加载指示器下方展示失败文案与重试按钮（画布门页设置拉取失败）。
 */
"use client";

import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface Props {
  /** 设置拉取失败：展示失败文案与重试按钮 */
  failed?: boolean;
  /** 重试回调（failed 时提供） */
  onRetry?: () => void;
}

export default function CanvasLoader({ failed = false, onRetry }: Props) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background">
      <Spinner className="size-8 text-primary" />
      {failed && onRetry && (
        <div className="flex flex-col items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {t("canvas.loadFailed")}
          </span>
          <Button size="sm" onClick={onRetry}>
            {t("canvas.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}

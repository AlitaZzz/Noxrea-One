/**
 * 画布加载动画：四叶草转圈。
 * 四片青柠叶瓣绕中心依次呼吸并整体旋转，置于石墨底上。
 * failed 时在动画下方展示失败文案与重试按钮（画布门页设置拉取失败）。
 */
"use client";

import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

interface Props {
  /** 设置拉取失败：展示失败文案与重试按钮 */
  failed?: boolean;
  /** 重试回调（failed 时提供） */
  onRetry?: () => void;
}

export default function CanvasLoader({ failed = false, onRetry }: Props) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4" style={{ background: "var(--background)" }}>
      <div className="canvas-clover">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="canvas-clover-petal"
            style={{ transform: `rotate(${i * 90}deg) translateY(-15px)`, animationDelay: `${i * 0.2}s` }}
          />
        ))}
      </div>
      {failed && onRetry && (
        <div className="flex flex-col items-center gap-2">
          <span className="text-sm" style={{ color: "var(--muted-foreground)" }}>
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

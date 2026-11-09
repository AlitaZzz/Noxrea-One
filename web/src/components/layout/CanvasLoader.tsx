/**
 * 画布加载状态（画布门页）。
 * 满屏网格 + Agent 骨架居中 + 四角内容节点 + SVG 贝塞尔曲线，
 * Agent 下方展示「正在进入画布」与阶段副标题。
 * failed 时在副标题下方展示失败文案与重试按钮（设置拉取失败）。
 *
 * 可访问性：role="status" + aria-label 声明完整语义文本供屏幕阅读器朗读；
 * 整个视觉容器（网格/SVG/节点/Agent 骨架/文字）标记 aria-hidden 防止重复朗读。
 * 样式类名前缀 canvas-loader-，动画与配色定义在 styles/globals.css。
 */
"use client";

import { useTranslation } from "react-i18next";

import { StarFilled } from "@/components/ui/AppIcon";
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
    <div
      className="fixed inset-0 z-50 overflow-hidden bg-background"
      role="status"
      aria-live="polite"
      aria-label={`${t("canvas.entering")}，${t("canvas.enteringSub")}`}
    >
      {/* 视觉容器：对屏幕阅读器隐藏（语义已由 aria-label 声明） */}
      <div aria-hidden className="absolute inset-0 overflow-hidden">
        {/* 满屏网格 */}
        <div className="canvas-loader-grid" />

        {/* 画布预演：SVG 曲线 + 内容节点 + Agent 骨架 + 文字 */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative h-[min(560px,82vh)] w-[min(880px,90vw)]">
            <svg className="canvas-loader-svg" viewBox="0 0 880 560" preserveAspectRatio="xMidYMid meet">
              <path d="M 340 210 C 260 230, 220 160, 175 135" />
              <path d="M 540 210 C 620 230, 660 160, 705 135" />
              <path d="M 350 290 C 270 320, 230 380, 195 425" />
              <path d="M 530 290 C 610 320, 650 380, 685 425" />
            </svg>

            <div className="canvas-loader-node canvas-loader-node-1">
              <div className="cl-thumb" />
              <div className="cl-bar" style={{ width: "80%" }} />
              <div className="cl-bar" style={{ width: "50%" }} />
            </div>
            <div className="canvas-loader-node canvas-loader-node-2">
              <div className="cl-bar" style={{ width: "90%" }} />
              <div className="cl-bar" style={{ width: "60%" }} />
              <div className="cl-bar" style={{ width: "75%" }} />
            </div>
            <div className="canvas-loader-node canvas-loader-node-3">
              <div className="cl-thumb" />
              <div className="cl-bar" style={{ width: "70%" }} />
              <div className="cl-bar" style={{ width: "45%" }} />
            </div>
            <div className="canvas-loader-node canvas-loader-node-4">
              <div className="cl-bar" style={{ width: "85%" }} />
              <div className="cl-bar" style={{ width: "65%" }} />
            </div>

            {/* Agent + 文字：同一 flex column 容器，文字自然跟随 Agent 底部 */}
            <div className="canvas-loader-agent-stack">
              <div className="canvas-loader-agent">
                <div className="canvas-loader-agent-header">
                  <div className="canvas-loader-agent-icon">
                    <StarFilled />
                  </div>
                  <span className="canvas-loader-agent-title">Agent</span>
                  <span className="canvas-loader-agent-status">
                    {t("canvas.agentThinking")}
                  </span>
                </div>
                <div className="canvas-loader-agent-body">
                  <div className="canvas-loader-agent-line" />
                  <div className="canvas-loader-agent-line" />
                  <div className="canvas-loader-agent-line" />
                </div>
                <div className="canvas-loader-agent-dots">
                  <i /><i /><i />
                  <span className="cl-label">{t("canvas.agentRestoring")}</span>
                </div>
              </div>
              <div className="canvas-loader-center">
                <div className="cl-title">{t("canvas.entering")}</div>
                <div className="cl-sub">{t("canvas.enteringSub")}</div>
                {failed && onRetry && (
                  <div className="mt-3 flex flex-col items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {t("canvas.loadFailed")}
                    </span>
                    <Button size="sm" onClick={onRetry}>
                      {t("canvas.retry")}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

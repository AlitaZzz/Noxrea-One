/**
 * 画布左上角项目工具条卡片尾部（项目名之后）的保存状态。
 *
 * `data-phase` 直接来自 SaveManager 的纯函数相位；可见文案走独立显示状态机：
 * - unsaved / blocked / offline / saved：立即切换；
 * - saving：延迟 500ms 才显示，快速保存不闪；
 * - saving → saved：saving 至少可见 200ms，避免只闪一帧；
 * - unknown / expired：不渲染胶囊。
 *
 * 组件自身订阅相位，父级位置帧重渲染不会波及。状态文本不接收指针事件，
 * 让卡片空白处的点击落到卡片背景而非文字。
 */
"use client";

import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { type CanvasSavePhase, saveManager } from "@/features/canvas/persistence/save-manager";
import { cn } from "@/lib/utils";

const SAVING_DISPLAY_DELAY_MS = 500;
const SAVING_MIN_VISIBLE_MS = 200;

const LABEL_KEYS = {
  blocked: "canvas.save.blocked",
  offline: "canvas.save.offline",
  saving: "canvas.save.saving",
  unsaved: "canvas.save.unsaved",
  saved: "canvas.save.saved",
} as const;

function isVisiblePhase(phase: CanvasSavePhase): phase is keyof typeof LABEL_KEYS {
  return phase in LABEL_KEYS;
}

function getServerPhase(): CanvasSavePhase {
  return "unknown";
}

function dotClassName(phase: CanvasSavePhase): string | null {
  switch (phase) {
    case "blocked":
      return "bg-destructive";
    case "offline":
    case "unsaved":
      return "bg-amber-400";
    case "saving":
      return "bg-amber-400 motion-safe:animate-pulse";
    default:
      return null;
  }
}

function CanvasSaveStatusIndicator() {
  const { t } = useTranslation();
  const phase = useSyncExternalStore(
    saveManager.subscribeSavePhase,
    saveManager.getSavePhase,
    getServerPhase,
  );

  // 延迟窗口内要显示的上一相位；saving 本身不写入。
  const [heldPhase, setHeldPhase] = useState<CanvasSavePhase>("unknown");
  // saving 是否已经越过 500ms 延迟真实显示。
  const [savingVisible, setSavingVisible] = useState(false);
  const savingShownAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (phase === "saving") {
      if (!savingVisible) {
        timer.current = setTimeout(() => {
          timer.current = null;
          savingShownAt.current = Date.now();
          setSavingVisible(true);
        }, SAVING_DISPLAY_DELAY_MS);
      }
    } else if (phase === "saved" && savingVisible && savingShownAt.current !== null) {
      // 只对 saving → saved 施加最小展示时长；离开 saving 去往其他相位立即切换。
      const remaining = SAVING_MIN_VISIBLE_MS - (Date.now() - savingShownAt.current);
      if (remaining > 0) {
        timer.current = setTimeout(() => {
          timer.current = null;
          savingShownAt.current = null;
          setSavingVisible(false);
        }, remaining);
      } else {
        savingShownAt.current = null;
        setSavingVisible(false);
      }
    } else {
      savingShownAt.current = null;
      setSavingVisible(false);
    }

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [phase, savingVisible]);

  // 渲染期同步派生：进入 saving 的同一渲染就能取到上一非 saving 相位。
  if (phase !== "saving" && phase !== heldPhase) {
    setHeldPhase(phase);
  }

  // 延迟窗口内不得跳回 saved：此前若显示已保存，改显示未保存直到 saving 出现。
  const delayedPhase = heldPhase === "saved" ? "unsaved" : heldPhase;
  const displayPhase: CanvasSavePhase =
    phase === "saving"
      ? savingVisible
        ? "saving"
        : delayedPhase
      : phase === "saved" && savingVisible
        ? "saving"
        : phase;

  const announcement =
    displayPhase === "blocked"
      ? t("canvas.save.blocked")
      : displayPhase === "offline"
        ? t("canvas.save.offline")
        : "";

  const visible = isVisiblePhase(displayPhase);
  const dot = visible ? dotClassName(displayPhase) : null;

  return (
    <>
      {visible && (
        <div
          data-testid="canvas-save-status"
          data-phase={phase}
          className={cn(
            "pointer-events-none flex shrink-0 select-none items-center gap-2 text-xs transition-colors",
            // saved 位于卡片表面（bg-card/70）：浅色 70% 前景实测 7.85:1，
            // 深色 muted 实测 7.13:1，均高于小字 AA 4.5:1。
            displayPhase === "saved" ? "text-foreground/70 dark:text-muted-foreground" : "text-foreground",
          )}
        >
          {dot && (
            <span
              data-testid="canvas-save-status-dot"
              className={cn("size-2 rounded-full", dot)}
              aria-hidden="true"
            />
          )}
          <span>{t(LABEL_KEYS[displayPhase])}</span>
        </div>
      )}
      {/* 始终挂载同一 live region 节点：隐藏态不卸载，恢复时才能可靠播报一次 */}
      <span className="sr-only" role="status">{announcement}</span>
    </>
  );
}

// 与位置无关的常驻指示器：父级在程序化位置帧逐帧重渲染时直接 bail。
export default memo(CanvasSaveStatusIndicator);

"use client";

import { useCallback } from "react";

import { useAppFeedback } from "@/components/ui/use-app-feedback";
import type { CanvasClipboardWriteResult } from "@/features/canvas/shared/canvas-system-clipboard";
import i18n from "@/lib/i18n/config";

/**
 * 系统剪贴板写入结果的统一提示。
 *
 * 写入失败不影响内部剪贴板与画布内粘贴，但必须让用户知道系统剪贴板没有更新：
 * - 超限提示具体原因；
 * - 不支持/被拒在同一会话只提示一次，避免每次复制都重复弹出。
 */
let systemWriteUnavailableNotified = false;

export function useCanvasClipboardFeedback(): (result: CanvasClipboardWriteResult) => void {
  const { message } = useAppFeedback();

  return useCallback(
    (result: CanvasClipboardWriteResult) => {
      if (result.ok) return;
      if (result.reason === "too-large") {
        message.info(i18n.t("common.copyTooLarge"));
        return;
      }
      if (!systemWriteUnavailableNotified) {
        systemWriteUnavailableNotified = true;
        message.info(i18n.t("common.copySystemUnavailable"));
      }
    },
    [message],
  );
}

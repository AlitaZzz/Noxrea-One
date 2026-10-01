"use client";

import { App, ConfigProvider } from "antd";
import { type ReactNode, useEffect, useMemo } from "react";

import { getLayerPopupContainer } from "@/components/ui/modal/layer-context";
import { directorTheme } from "@/components/ui/theme";
import { FeedbackContext } from "@/components/ui/use-app-feedback";
import { type FeedbackApi, type FeedbackKind, type NotificationOptions, registerFeedback } from "@/lib/feedback";
import { onSessionChange } from "@/lib/session-lifecycle";

function FeedbackProvider({ children }: { children: ReactNode }) {
  const { message, notification } = App.useApp();
  const feedback = useMemo<FeedbackApi>(() => {
    const notify = (kind: FeedbackKind, options: NotificationOptions) => {
      notification[kind]({ ...options, placement: options.placement ?? "bottomRight",
        duration: options.duration ?? (kind === "error" ? 6 : 5) });
    };
    return {
      message: {
        success: (text) => { void message.success(text); },
        error: (text) => { void message.error(text); },
        info: (text) => { void message.info(text); },
        warning: (text) => { void message.warning(text); },
      },
      notification: {
        success: (options) => notify("success", options),
        error: (options) => notify("error", options),
        info: (options) => notify("info", options),
        warning: (options) => notify("warning", options),
      },
    };
  }, [message, notification]);
  useEffect(() => registerFeedback(feedback), [feedback]);
  useEffect(() => onSessionChange(() => {
    message.destroy();
    notification.destroy();
  }), [message, notification]);
  return <FeedbackContext.Provider value={feedback}>{children}</FeedbackContext.Provider>;
}

export default function AppUiProvider({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={directorTheme()} getPopupContainer={getLayerPopupContainer}>
      <App><FeedbackProvider>{children}</FeedbackProvider></App>
    </ConfigProvider>
  );
}

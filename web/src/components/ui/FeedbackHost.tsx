"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CheckOutlined, CloseOutlined, ExclamationCircleOutlined, InfoCircleOutlined, WarningOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { FeedbackContext } from "@/components/ui/use-app-feedback";
import { type FeedbackApi, type FeedbackKind, type NotificationOptions, registerFeedback } from "@/lib/feedback";
import { onSessionChange } from "@/lib/session-lifecycle";
import { cn } from "@/lib/utils";

interface MessageItem {
  id: string;
  kind: FeedbackKind;
  text: string;
}

interface NotificationItem {
  id: string;
  kind: FeedbackKind;
  title: string;
  description?: ReactNode;
  key?: string;
}

function ToneIcon({ kind }: { kind: FeedbackKind }) {
  const Icon = kind === "success"
    ? CheckOutlined
    : kind === "error"
      ? ExclamationCircleOutlined
      : kind === "warning"
        ? WarningOutlined
        : InfoCircleOutlined;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex shrink-0 [&_svg]:size-4",
        kind === "error" && "text-destructive",
        kind === "warning" && "text-chart-4",
        (kind === "success" || kind === "info") && "text-primary",
      )}
    >
      <Icon />
    </span>
  );
}

function FeedbackViewport({
  messages,
  notifications,
  onDismissMessage,
  onDismissNotification,
}: {
  messages: MessageItem[];
  notifications: NotificationItem[];
  onDismissMessage: (id: string) => void;
  onDismissNotification: (id: string) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[1400] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
    >
      <div className="flex flex-col gap-2">
        {messages.map((item) => (
          <div
            key={item.id}
            className="pointer-events-auto flex min-w-0 items-center gap-2.5 rounded-lg border border-input bg-popover px-3 py-2.5 text-popover-foreground shadow-lg"
            role="status"
          >
            <ToneIcon kind={item.kind} />
            <span className="min-w-0 flex-1 break-words text-sm leading-[18px]">{item.text}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-auto shrink-0 text-muted-foreground"
              aria-label="Close"
              onClick={() => onDismissMessage(item.id)}
            >
              <CloseOutlined />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {notifications.map((item) => (
          <div
            key={item.id}
            className="pointer-events-auto flex min-w-0 items-start gap-2.5 rounded-lg border border-input bg-popover px-3 py-2.5 text-popover-foreground shadow-lg"
            role="alert"
          >
            <ToneIcon kind={item.kind} />
            <div className="min-w-0 flex-1">
              <strong className="block text-sm font-medium leading-[18px]">{item.title}</strong>
              {item.description && <div className="mt-1 break-words text-xs/relaxed text-muted-foreground">{item.description}</div>}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-auto shrink-0 text-muted-foreground"
              aria-label="Close"
              onClick={() => onDismissNotification(item.id)}
            >
              <CloseOutlined />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FeedbackHost({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const notificationsRef = useRef<NotificationItem[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const sequenceRef = useRef(0);

  const nextId = useCallback((channel: string) => `${channel}-${++sequenceRef.current}`, []);
  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(id);
  }, []);
  const dismissMessage = useCallback((id: string) => {
    clearTimer(id);
    setMessages((current) => current.filter((item) => item.id !== id));
  }, [clearTimer]);
  const dismissNotification = useCallback((id: string) => {
    clearTimer(id);
    setNotifications((current) => {
      const next = current.filter((item) => item.id !== id);
      notificationsRef.current = next;
      return next;
    });
  }, [clearTimer]);
  const scheduleDismiss = useCallback((id: string, duration?: number) => {
    clearTimer(id);
    if (duration === 0) return;
    timersRef.current.set(id, setTimeout(() => {
      dismissMessage(id);
      dismissNotification(id);
    }, Math.max(0, duration ?? 5) * 1000));
  }, [clearTimer, dismissMessage, dismissNotification]);

  const showMessage = useCallback((kind: FeedbackKind, text: string) => {
    const id = nextId("message");
    setMessages((current) => [...current, { id, kind, text }]);
    scheduleDismiss(id, 3);
  }, [nextId, scheduleDismiss]);
  const showNotification = useCallback((kind: FeedbackKind, options: NotificationOptions) => {
    const existing = options.key ? notificationsRef.current.find((item) => item.key === options.key) : undefined;
    const id = existing?.id ?? nextId("notification");
    const item = { id, kind, title: options.title, description: options.description, key: options.key };
    setNotifications((current) => {
      const next = existing ? current.map((entry) => entry.id === id ? item : entry) : [...current, item];
      notificationsRef.current = next;
      return next;
    });
    scheduleDismiss(id, options.duration ?? (kind === "error" ? 6 : 5));
  }, [nextId, scheduleDismiss]);
  const clearAll = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
    notificationsRef.current = [];
    setMessages([]);
    setNotifications([]);
  }, []);

  const feedback = useMemo<FeedbackApi>(() => ({
    message: {
      success: (text) => showMessage("success", text),
      error: (text) => showMessage("error", text),
      info: (text) => showMessage("info", text),
      warning: (text) => showMessage("warning", text),
    },
    notification: {
      success: (options) => showNotification("success", options),
      error: (options) => showNotification("error", options),
      info: (options) => showNotification("info", options),
      warning: (options) => showNotification("warning", options),
    },
  }), [showMessage, showNotification]);

  useEffect(() => registerFeedback(feedback), [feedback]);
  useEffect(() => onSessionChange(clearAll), [clearAll]);
  useEffect(() => () => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
  }, []);

  return (
    <FeedbackContext.Provider value={feedback}>
      {children}
      <FeedbackViewport
        messages={messages}
        notifications={notifications}
        onDismissMessage={dismissMessage}
        onDismissNotification={dismissNotification}
      />
    </FeedbackContext.Provider>
  );
}

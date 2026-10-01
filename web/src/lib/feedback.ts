import type { ReactNode } from "react";

import { onSessionChange } from "@/lib/session-lifecycle";

export type FeedbackKind = "success" | "error" | "info" | "warning";
export interface NotificationOptions {
  title: string;
  description?: ReactNode;
  placement?: "bottomRight";
  duration?: number;
  key?: string;
}
export type MessageApi = Record<FeedbackKind, (text: string) => void>;
export type NotificationApi = Record<FeedbackKind, (options: NotificationOptions) => void>;
export interface FeedbackApi {
  message: MessageApi;
  notification: NotificationApi;
}
type FeedbackEvent =
  | { channel: "message"; kind: FeedbackKind; payload: string }
  | { channel: "notification"; kind: FeedbackKind; payload: NotificationOptions };

let current: { api: FeedbackApi } | null = null;
const pending: FeedbackEvent[] = [];
onSessionChange(() => { pending.length = 0; });

function deliver(api: FeedbackApi, event: FeedbackEvent) {
  if (event.channel === "message") api.message[event.kind](event.payload);
  else api.notification[event.kind](event.payload);
}
function emit(event: FeedbackEvent) {
  if (current) deliver(current.api, event);
  else pending.push(event);
}

// Stable facades also serve callers that obtained an API before the UI mounted.
export const globalFeedback: FeedbackApi = {
  message: {
    success: (payload) => emit({ channel: "message", kind: "success", payload }),
    error: (payload) => emit({ channel: "message", kind: "error", payload }),
    info: (payload) => emit({ channel: "message", kind: "info", payload }),
    warning: (payload) => emit({ channel: "message", kind: "warning", payload }),
  },
  notification: {
    success: (payload) => emit({ channel: "notification", kind: "success", payload: { ...payload } }),
    error: (payload) => emit({ channel: "notification", kind: "error", payload: { ...payload } }),
    info: (payload) => emit({ channel: "notification", kind: "info", payload: { ...payload } }),
    warning: (payload) => emit({ channel: "notification", kind: "warning", payload: { ...payload } }),
  },
};

/** Stale cleanup cannot remove a newer adapter. Queued events are delivered once. */
export function registerFeedback(api: FeedbackApi): () => void {
  const registration = { api };
  current = registration;
  while (pending.length && current === registration) deliver(api, pending.shift()!);
  return () => { if (current === registration) current = null; };
}

import { globalFeedback, type NotificationApi } from "@/lib/feedback";

/** Non-React callers share the adapter registered by the UI provider. */
export function showGlobalNotification(): NotificationApi {
  return globalFeedback.notification;
}

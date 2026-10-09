import { ApiError } from "@/lib/api/client";
import { resolveApiError } from "@/lib/api/error-message";
import { globalFeedback, type NotificationApi } from "@/lib/feedback";
import { SessionChangedError } from "@/lib/session-lifecycle";

/** Non-React callers share the adapter registered by the UI provider. */
export function showGlobalNotification(): NotificationApi {
  return globalFeedback.notification;
}

/** 写操作失败提示；会话切换期间的取消不应覆盖新会话的反馈。 */
export function notifyFailure(e: unknown, fallbackKey: string): void {
  if (e instanceof SessionChangedError) return;
  showGlobalNotification().error({
    title: e instanceof ApiError ? e.message : resolveApiError(null, undefined, fallbackKey),
    placement: "bottomRight",
    duration: 6,
  });
}

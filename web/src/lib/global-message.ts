import { globalFeedback, type MessageApi } from "@/lib/feedback";

/** Non-React callers share the adapter registered by the UI provider. */
export function showGlobalMessage(): MessageApi {
  return globalFeedback.message;
}

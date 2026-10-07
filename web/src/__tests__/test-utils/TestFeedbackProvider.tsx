import type { ReactNode } from "react";
import { vi } from "vitest";

import { FeedbackContext } from "@/components/ui/use-app-feedback";
import type { FeedbackApi } from "@/lib/feedback";

export function createTestFeedback(): FeedbackApi {
  return {
    message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
    notification: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  };
}
const feedback = createTestFeedback();
export function TestFeedbackProvider({ children }: { children: ReactNode }) {
  return <FeedbackContext.Provider value={feedback}>{children}</FeedbackContext.Provider>;
}

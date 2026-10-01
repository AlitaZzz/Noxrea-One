"use client";

import { createContext, useContext } from "react";

import type { FeedbackApi } from "@/lib/feedback";

export const FeedbackContext = createContext<FeedbackApi | null>(null);

export function useAppFeedback(): FeedbackApi {
  const feedback = useContext(FeedbackContext);
  if (!feedback) throw new Error("useAppFeedback requires AppUiProvider");
  return feedback;
}

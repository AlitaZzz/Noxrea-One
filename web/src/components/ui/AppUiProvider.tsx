"use client";

import type { ReactNode } from "react";

import FeedbackHost from "@/components/ui/FeedbackHost";
import { TooltipProvider } from "@/components/ui/tooltip";

export default function AppUiProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <FeedbackHost>{children}</FeedbackHost>
    </TooltipProvider>
  );
}

"use client";

import { Spin } from "antd";
import type { ReactElement } from "react";

export interface AppSpinnerProps { size?: "small" | "default" | "large"; indicator?: ReactElement }
export default function AppSpinner({ indicator, ...props }: AppSpinnerProps) { return <Spin {...props} indicator={indicator ? <span>{indicator}</span> : undefined} />; }

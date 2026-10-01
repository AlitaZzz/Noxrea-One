"use client";

import { Progress } from "antd";

export interface AppProgressProps {
  shape?: "circle" | "line";
  value: number;
  size?: number;
  color?: string;
  trackColor?: string;
  status?: "active" | "success" | "exception";
}
export default function AppProgress({ shape = "line", value, color, trackColor, ...props }: AppProgressProps) {
  return <Progress {...props} type={shape} percent={value} strokeColor={color} railColor={trackColor} />;
}

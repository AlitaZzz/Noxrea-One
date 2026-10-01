"use client";

import { Switch } from "antd";

export interface AppSwitchProps { checked: boolean; onChange?: (checked: boolean) => void; disabled?: boolean; size?: "small" | "default" }
export default function AppSwitch(props: AppSwitchProps) { return <Switch {...props} />; }

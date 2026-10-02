/**
 * 模型品牌图标。
 * 按模型名（支持 "provider/model" 整串）匹配品牌图标，未命中时回退到通用机器人图标。
 *
 * 归属说明：品牌映射表是模型领域知识，被 settings（配置）与 canvas（使用）共同消费，
 * 因此放在中立的 features/model 切片，避免 settings 与 canvas 互相依赖。
 */
import type { ComponentType, CSSProperties } from "react";

import { RobotOutlined } from "@/components/ui/AppIcon";
import { AgnesIcon } from "@/components/ui/AppIcon";
import { ClaudeIcon } from "@/components/ui/AppIcon";
import { DeepSeekIcon } from "@/components/ui/AppIcon";
import { DoubaoIcon } from "@/components/ui/AppIcon";
import { FluxIcon } from "@/components/ui/AppIcon";
import { GeminiIcon } from "@/components/ui/AppIcon";
import { GLMIcon } from "@/components/ui/AppIcon";
import { GrokIcon } from "@/components/ui/AppIcon";
import { HappyHorseIcon } from "@/components/ui/AppIcon";
import { KimiIcon } from "@/components/ui/AppIcon";
import { KlingIcon } from "@/components/ui/AppIcon";
import { MiniMaxIcon } from "@/components/ui/AppIcon";
import { OpenAIIcon } from "@/components/ui/AppIcon";
import { QwenIcon } from "@/components/ui/AppIcon";
import { SeedanceIcon } from "@/components/ui/AppIcon";
import { SunoIcon } from "@/components/ui/AppIcon";
import { ViduIcon } from "@/components/ui/AppIcon";

type ModelIconType = ComponentType<{ className?: string; style?: CSSProperties }>;

const ICON_MAP: { test: RegExp; Icon: ModelIconType }[] = [
  { test: /agnes/i, Icon: AgnesIcon },
  { test: /claude|anthropic/i, Icon: ClaudeIcon },
  { test: /gpt|openai|dall|sora|chatgpt/i, Icon: OpenAIIcon },
  { test: /gemini|google|veo|nano-?banana/i, Icon: GeminiIcon },
  { test: /deepseek/i, Icon: DeepSeekIcon },
  { test: /glm|chatglm|zhipu/i, Icon: GLMIcon },
  { test: /grok|xai/i, Icon: GrokIcon },
  { test: /doubao|豆包/i, Icon: DoubaoIcon },
  { test: /seedream|seedance/i, Icon: SeedanceIcon },
  { test: /minimax/i, Icon: MiniMaxIcon },
  { test: /qwen|通义|tongyi|wan2?|z-image/i, Icon: QwenIcon },
  { test: /flux|black forest/i, Icon: FluxIcon },
  { test: /kimi|moonshot/i, Icon: KimiIcon },
  { test: /kling|可灵/i, Icon: KlingIcon },
  { test: /happyhorse/i, Icon: HappyHorseIcon },
  { test: /vidu/i, Icon: ViduIcon },
  { test: /suno/i, Icon: SunoIcon },
];

/** 根据模型名（支持 provider/model 整串）解析品牌图标组件，未命中返回 null */
export function resolveModelIcon(model: string): ModelIconType | null {
  for (const { test, Icon } of ICON_MAP) {
    if (test.test(model)) return Icon;
  }
  return null;
}

interface ModelIconProps {
  model: string;
  className?: string;
  style?: CSSProperties;
}

/** 渲染模型品牌图标，未命中时回退到通用 RobotOutlined */
export function ModelIcon({ model, className, style }: ModelIconProps) {
  const cls = className ?? "size-4 shrink-0";
  // 直接遍历顶层声明的 ICON_MAP（组件均为模块级常量），避免「渲染期创建组件」
  for (const { test, Icon } of ICON_MAP) {
    if (test.test(model)) return <Icon className={cls} style={style} />;
  }
  return <RobotOutlined className={cls} style={style} />;
}

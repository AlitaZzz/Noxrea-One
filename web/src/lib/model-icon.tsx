import type { ComponentType } from "react";
import type { CSSProperties } from "react";
import { RobotOutlined } from "@ant-design/icons";

import { ClaudeIcon } from "@/components/ui/icons/models/ClaudeIcon";
import { OpenAIIcon } from "@/components/ui/icons/models/OpenAIIcon";
import { GeminiIcon } from "@/components/ui/icons/models/GeminiIcon";
import { DeepSeekIcon } from "@/components/ui/icons/models/DeepSeekIcon";
import { GLMIcon } from "@/components/ui/icons/models/GLMIcon";
import { GrokIcon } from "@/components/ui/icons/models/GrokIcon";
import { DoubaoIcon } from "@/components/ui/icons/models/DoubaoIcon";
import { SeedanceIcon } from "@/components/ui/icons/models/SeedanceIcon";
import { MiniMaxIcon } from "@/components/ui/icons/models/MiniMaxIcon";
import { QwenIcon } from "@/components/ui/icons/models/QwenIcon";
import { FluxIcon } from "@/components/ui/icons/models/FluxIcon";
import { KimiIcon } from "@/components/ui/icons/models/KimiIcon";
import { KlingIcon } from "@/components/ui/icons/models/KlingIcon";
import { HappyHorseIcon } from "@/components/ui/icons/models/HappyHorseIcon";
import { ViduIcon } from "@/components/ui/icons/models/ViduIcon";
import { SunoIcon } from "@/components/ui/icons/models/SunoIcon";

type ModelIconType = ComponentType<{ className?: string; style?: CSSProperties }>;

const ICON_MAP: { test: RegExp; Icon: ModelIconType }[] = [
  { test: /claude|anthropic/i, Icon: ClaudeIcon },
  { test: /gpt|openai|dall|sora|chatgpt/i, Icon: OpenAIIcon },
  { test: /gemini|google|veo/i, Icon: GeminiIcon },
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

/** 根据模型名（支持 channel/model 整串）解析品牌图标组件，未命中返回 null */
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
  const Icon = resolveModelIcon(model);
  if (Icon) return <Icon className={cls} style={style} />;
  return <RobotOutlined className={cls} style={style} />;
}

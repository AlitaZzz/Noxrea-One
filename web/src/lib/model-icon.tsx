import { RobotOutlined } from "@ant-design/icons";
import type { ComponentType } from "react";
import type { CSSProperties } from "react";

import { ClaudeIcon } from "@/components/ui/icons/models/ClaudeIcon";
import { DeepSeekIcon } from "@/components/ui/icons/models/DeepSeekIcon";
import { DoubaoIcon } from "@/components/ui/icons/models/DoubaoIcon";
import { FluxIcon } from "@/components/ui/icons/models/FluxIcon";
import { GeminiIcon } from "@/components/ui/icons/models/GeminiIcon";
import { GLMIcon } from "@/components/ui/icons/models/GLMIcon";
import { GrokIcon } from "@/components/ui/icons/models/GrokIcon";
import { HappyHorseIcon } from "@/components/ui/icons/models/HappyHorseIcon";
import { KimiIcon } from "@/components/ui/icons/models/KimiIcon";
import { KlingIcon } from "@/components/ui/icons/models/KlingIcon";
import { MiniMaxIcon } from "@/components/ui/icons/models/MiniMaxIcon";
import { OpenAIIcon } from "@/components/ui/icons/models/OpenAIIcon";
import { QwenIcon } from "@/components/ui/icons/models/QwenIcon";
import { SeedanceIcon } from "@/components/ui/icons/models/SeedanceIcon";
import { SunoIcon } from "@/components/ui/icons/models/SunoIcon";
import { ViduIcon } from "@/components/ui/icons/models/ViduIcon";

type ModelIconType = ComponentType<{ className?: string; style?: CSSProperties }>;

const ICON_MAP: { test: RegExp; Icon: ModelIconType }[] = [
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

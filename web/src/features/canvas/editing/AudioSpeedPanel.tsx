/**
 * 音频变速调节面板：✗ 关闭 +「变速」标题 + 滑杆（0.1×–4×）+ 数字输入（上下步进）+ ↑ 确认。
 * 纯展示组件：由 NodeToolbar 的变速模式渲染（宿主已在 RfNodeToolbar 内），
 * 拖动/输入即实时回调（onSpeedChange），↑ 应用 / ✗ 取消。
 */
"use client";

import { useTranslation } from "react-i18next";

import { CloseOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import IconActionButton from "@/components/ui/IconActionButton";
import { NumberInput } from "@/components/ui/number-input";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";

interface AudioSpeedPanelProps {
  /** 草稿倍率（拖动/输入中实时变化） */
  speed: number;
  onSpeedChange: (speed: number) => void;
  onApply: () => void;
  onCancel: () => void;
}

const SPEED_MIN = 0.1;
const SPEED_MAX = 4;
const SPEED_STEP = 0.05;

export default function AudioSpeedPanel({ speed, onSpeedChange, onApply, onCancel }: AudioSpeedPanelProps) {
  const { t } = useTranslation();

  const clamp = (v: number) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(v * 100) / 100));
  return (
    <>
      {/* 左组：✗ 关闭 + 标题 */}
      <div className="flex shrink-0 items-center gap-1">
        <Button size="icon" variant="ghost" onClick={onCancel} ><CloseOutlined /></Button>
        <span className="text-[13px] text-foreground">{t("node.audioSpeed")}</span>
      </div>

      <Separator orientation="vertical" className="mx-1 h-5 self-center" />

      {/* 中组：0.1x — 滑杆 — 4.0x（固定宽度：外层工具栏宽度由内容撑开，
          flex-1 在自适应容器里会坍缩为 0，滑杆必须靠显式宽度撑起） */}
      <div className="flex h-8 w-[180px] shrink-0 items-center gap-2 px-2">
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">0.1x</span>
        <Slider
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          value={[speed]}
          onValueChange={([next]) => onSpeedChange(Math.round(next * 100) / 100)}
          className="w-full"
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">4.0x</span>
      </div>

      {/* 右组：数字输入 + 上下步进 */}
      <NumberInput
        min={SPEED_MIN}
        max={SPEED_MAX}
        step={SPEED_STEP}
        value={speed}
        onChange={(v) => { if (v != null) onSpeedChange(clamp(v)); }}
        className="h-8 w-[92px] shrink-0"
        suffix="×"
      />

      <Separator orientation="vertical" className="mx-1 h-5 self-center" />
      {/* 确认：↑ 反色箭头 */}
      <IconActionButton onClick={onApply} />
    </>
  );
}

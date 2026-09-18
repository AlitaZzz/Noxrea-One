/**
 * 音频变速调节面板：✗ 关闭 +「变速」标题 + 滑杆（0.1×–4×）+ 数字输入（上下步进）+ ↑ 确认。
 * 纯展示组件：由 NodeToolbar 的变速模式渲染（宿主已在 RfNodeToolbar 内），
 * 拖动/输入即实时回调（onSpeedChange），↑ 应用 / ✗ 取消。
 */
"use client";

import { CaretDownOutlined, CaretUpOutlined, CloseOutlined } from "@ant-design/icons";
import { Button, InputNumber, Slider } from "antd";
import { useTranslation } from "react-i18next";

import PrimaryActionButton from "./PrimaryActionButton";

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
  const stepUp = () => onSpeedChange(clamp(speed + SPEED_STEP));
  const stepDown = () => onSpeedChange(clamp(speed - SPEED_STEP));

  return (
    <>
      {/* 左组：✗ 关闭 + 标题 */}
      <div className="flex shrink-0 items-center gap-1">
        <Button type="text" size="middle" style={{ padding: 8 }} icon={<CloseOutlined />} onClick={onCancel} />
        <span className="text-[13px]" style={{ color: "var(--canvas-text)" }}>{t("node.audioSpeed")}</span>
      </div>

      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

      {/* 中组：0.1x — 滑杆 — 4.0x（固定宽度：外层工具栏宽度由内容撑开，
          flex-1 在自适应容器里会坍缩为 0，滑杆必须靠显式宽度撑起） */}
      <div className="flex h-8 w-[180px] shrink-0 items-center gap-2 px-2">
        <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--canvas-text-dim)" }}>0.1x</span>
        <Slider
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          value={speed}
          tooltip={{ open: false }}
          onChange={(v) => onSpeedChange(Math.round(v * 100) / 100)}
          style={{ width: "100%", margin: 0 }}
        />
        <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--canvas-text-dim)" }}>4.0x</span>
      </div>

      {/* 右组：数字输入 + 上下步进 */}
      <div
        className="flex h-8 shrink-0 items-center overflow-hidden rounded-lg pl-2 pr-0"
        style={{ background: "var(--canvas-bg-hover)" }}
      >
        <InputNumber
          size="small"
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          value={speed}
          controls={false}
          variant="borderless"
          onChange={(v) => { if (v != null) onSpeedChange(clamp(v)); }}
          style={{ width: 60, background: "transparent" }}
          suffix="×"
        />
        <div className="flex h-full w-5 shrink-0 flex-col overflow-hidden">
          <Button
            type="text"
            size="small"
            style={{ height: 16, padding: 0 }}
            icon={<CaretUpOutlined style={{ fontSize: 10 }} />}
            onClick={stepUp}
          />
          <Button
            type="text"
            size="small"
            style={{ height: 16, padding: 0 }}
            icon={<CaretDownOutlined style={{ fontSize: 10 }} />}
            onClick={stepDown}
          />
        </div>
      </div>

      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />
      {/* 确认：↑ 反色箭头 */}
      <PrimaryActionButton onClick={onApply} />
    </>
  );
}

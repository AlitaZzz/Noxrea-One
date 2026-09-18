/**
 * 音频片段截取工具栏：✗ 关闭 +「截取」标题 + 所选时间段 + ✓ 确认，
 * 经 RfNodeToolbar 挂在节点上方。纯展示组件：选区状态与确认/取消动作
 * 由宿主（AudioWaveform）提供。布局与变速调节面板（AudioSpeedPanel）一致。
 */
"use client";

import { CloseOutlined } from "@ant-design/icons";
import { NodeToolbar as RfNodeToolbar, Position } from "@xyflow/react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { formatTime } from "@/lib/utils/format";

import PrimaryActionButton from "./PrimaryActionButton";


interface AudioClipPanelProps {
  /** RfNodeToolbar 定位用；宿主渲染在节点包装层内时可省略（取上下文节点） */
  nodeId?: string;
  /** 当前选区（秒）；null = 尚未初始化 */
  range: { start: number; end: number } | null;
  onConfirm?: (start: number, end: number) => void;
  onCancel?: () => void;
}

export default function AudioClipPanel({ nodeId, range, onConfirm, onCancel }: AudioClipPanelProps) {
  const { t } = useTranslation();

  return (
    <RfNodeToolbar nodeId={nodeId} position={Position.Top} align="center" offset={8} isVisible>
      <div
        className="canvas-toolbar nodrag flex items-center gap-1 rounded-xl"
        style={{ height: 50, padding: "6px 10px", whiteSpace: "nowrap" }}
      >
        {/* 左组：✗ 关闭 + 标题 */}
        <div className="flex shrink-0 items-center gap-1">
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<CloseOutlined />} onClick={onCancel} />
          <span className="text-[13px]" style={{ color: "var(--canvas-text)" }}>{t("clip.menu")}</span>
        </div>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* 中组：所选时间段 */}
        <div className="flex h-8 min-w-0 flex-1 items-center px-2">
          <span className="whitespace-nowrap text-sm tabular-nums" style={{ color: "var(--canvas-text)" }}>
            {range ? `${formatTime(range.start)} - ${formatTime(range.end)}` : "--"}
          </span>
        </div>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* 右组：确认（反色 ↑，与变速面板一致） */}
        <PrimaryActionButton
          disabled={!range}
          onClick={() => range && onConfirm?.(range.start, range.end)}
        />
      </div>
    </RfNodeToolbar>
  );
}

/**
 * 参考区「音频」缩略卡片（视频 / 文本生成面板共用）。
 *
 * 展示音频 label、角标编号（音频N），悬停显示播放 / 停止图标，
 * 移出或播完自动停止且下次从头播放；支持音频之间的拖拽排序与 ✕ 断开连线。
 */
"use client";

import { Button } from "antd";
import { memo, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { PlayIcon } from "@/components/ui/icons/media/PlayIcon";
import { StopIcon } from "@/components/ui/icons/media/StopIcon";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

import { useRevealCanvasNode } from "./reveal-node";

export interface AudioRefCardProps {
  /** 上游音频参考（节点 id / 音频地址 / 展示名） */
  audio: { id: string; src: string; label: string };
  /** 生成面板所属节点 id（用于 ✕ 断开对应连线） */
  nodeId: string;
  /** 在同类型参考中的序号（0-based），用于角标与 @ 引用编号 */
  index: number;
  /** 拖放排序回调（dragged / target 均为音频 src） */
  onReorder: (dragged: string, target: string) => void;
  /** 上报自身拖拽状态（父级聚合后经 dragActive 回传，用于抑制其它卡片预览） */
  onDragStateChange?: (dragging: boolean) => void;
}

function AudioRefCard({
  audio,
  nodeId,
  index,
  onReorder,
  onDragStateChange,
}: AudioRefCardProps) {
  const { t } = useTranslation();
  const reveal = useRevealCanvasNode();
  const [hovered, setHovered] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0; // 下次从头播放
    }
    setPlaying(false);
  }, []);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      stop();
    } else {
      el.currentTime = 0;
      void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  }, [playing, stop]);

  return (
    <div
      className={`relative group h-14 w-14 rounded flex items-center justify-center transition-shadow cursor-grab active:cursor-grabbing ${dragOver ? "ring-2 ring-white shadow-lg" : ""}`}
      style={{ background: "var(--canvas-bg-hover)", border: "1px solid var(--canvas-border)" }}
      draggable
      onDoubleClick={() => {
        const s = useCanvasStore.getState();
        const n = s.nodes.find((x) => x.id === audio.id);
        if (n) reveal(n);
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-ref-audio", audio.src);
        e.dataTransfer.setData("text/plain", audio.src);
        e.dataTransfer.effectAllowed = "move";
        onDragStateChange?.(true);
        // 锚定卡片中心，保证拖拽图像跟随鼠标
        e.dataTransfer.setDragImage(e.currentTarget as HTMLElement, 28, 28);
      }}
      onDragEnd={() => onDragStateChange?.(false)}
      onDragEnter={(e) => {
        // 部分浏览器要求 dragenter 也 preventDefault，否则后续 drop 不会触发
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.dataTransfer.types.includes("application/x-ref-audio")) {
          e.dataTransfer.dropEffect = "none"; // 仅音频可放到音频位置
          return;
        }
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        const dragged = e.dataTransfer.getData("text/plain");
        if (!dragged || dragged === audio.src) return;
        onReorder(dragged, audio.src); // 面板侧按 refAudioOrder 校验，非音频自动忽略
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        if (playing) stop();
      }}
    >
      <WaveIcon className="pointer-events-none" style={{ color: "var(--canvas-text)", width: 16, height: 16 }} />
      {/* 底部半透明编号条：与卡片下缘齐平，仿播放器字幕条 */}
      <span className="absolute inset-x-0 bottom-0 h-4 flex items-center justify-center rounded-b text-[10px] font-semibold pointer-events-none whitespace-nowrap" style={{ background: "rgba(0,0,0,0.5)", color: "#fff" }}>{t("common.refAudioLabel", { index: index + 1 })}</span>
      {/* 悬停时覆盖中央的播放/停止图标，点击可播放 */}
      {hovered && (
        <Button
          type="text"
          size="small"
          aria-label={playing ? "停止" : "播放"}
          className="!absolute inset-0 !m-auto !w-7 !h-7 !flex items-center justify-center !rounded-full !bg-black/60 !text-white hover:!text-white hover:!bg-black/70 !p-0 !border-0"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          {playing ? (
            <StopIcon style={{ color: "#fff", width: 16, height: 16 }} />
          ) : (
            <PlayIcon style={{ color: "#fff", width: 16, height: 16 }} />
          )}
        </Button>
      )}
      {/* 播放中不悬停时也显示停止图标，便于随时停止 */}
      {playing && !hovered && (
        <Button
          type="text"
          size="small"
          aria-label="停止"
          className="!absolute inset-0 !m-auto !w-7 !h-7 !flex items-center justify-center !rounded-full !bg-black/60 !text-white hover:!text-white hover:!bg-black/70 !p-0 !border-0"
          onClick={(e) => {
            e.stopPropagation();
            stop();
          }}
        >
          <StopIcon style={{ color: "#fff", width: 16, height: 16 }} />
        </Button>
      )}
      <Button type="text" size="small"
        className="!absolute -top-1.5 -right-1.5 !w-4 !h-4 !flex items-center justify-center !rounded-full !bg-black/70 !text-white/60 hover:!text-white hover:!bg-white/30 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity !p-0 !border-0"
        onClick={() => {
          const store = useCanvasStore.getState();
          const edge = store.edges.find((e) => e.target === nodeId && e.source === audio.id);
          if (edge) store.removeEdges([edge.id]);
        }}>✕</Button>
      <audio
        ref={audioRef}
        src={audio.src}
        preload="none"
        onEnded={() => setPlaying(false)}
        onPause={() => {
          if (audioRef.current && audioRef.current.currentTime === 0) setPlaying(false);
        }}
      />
    </div>
  );
}

export default memo(AudioRefCard);

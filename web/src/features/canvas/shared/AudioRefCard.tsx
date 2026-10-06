/**
 * 参考区「音频」缩略卡片（视频 / 文本生成面板共用）。
 *
 * 展示音频 label、角标编号（音频N），悬停显示播放 / 停止图标，
 * 移出或播完自动停止且下次从头播放；支持音频之间的拖拽排序与 ✕ 断开连线。
 */
"use client";

import { memo, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { PlayIcon, StopIcon, WaveIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

import { ReferenceIndexBadge, ReferenceRemoveButton } from "./ReferenceCardChrome";
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
    <Card
      className={`group relative flex h-14 w-14 flex-row items-center justify-center rounded-md border-border bg-accent p-0 shadow-none transition-shadow cursor-grab active:cursor-grabbing ${dragOver ? "ring-2 ring-white shadow-lg" : ""}`}
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
      <WaveIcon className="pointer-events-none" style={{ color: "var(--foreground)", width: 16, height: 16 }} />
      <ReferenceIndexBadge>{t("common.refAudioLabel", { index: index + 1 })}</ReferenceIndexBadge>
      {/* 悬停时覆盖中央的播放/停止图标，点击可播放 */}
      {hovered && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={playing ? t("common.stop") : t("common.play")}
          className="absolute inset-0 m-auto rounded-full bg-black/50 p-0 text-white/70 hover:bg-black/70 hover:text-white"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          {playing ? (
            <StopIcon className="size-3" />
          ) : (
            <PlayIcon className="size-3" />
          )}
        </Button>
      )}
      {/* 播放中不悬停时也显示停止图标，便于随时停止 */}
      {playing && !hovered && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t("common.stop")}
          className="absolute inset-0 m-auto rounded-full bg-black/50 p-0 text-white/70 hover:bg-black/70 hover:text-white"
          onClick={(e) => {
            e.stopPropagation();
            stop();
          }}
        >
          <StopIcon className="size-3" />
        </Button>
      )}
      <ReferenceRemoveButton
        ariaLabel={t("common.delete")}
        onRemove={() => {
          const store = useCanvasStore.getState();
          const edge = store.edges.find((e) => e.target === nodeId && e.source === audio.id);
          if (edge) store.removeEdges([edge.id]);
        }}
      />
      <audio
        ref={audioRef}
        src={audio.src}
        preload="none"
        onEnded={() => setPlaying(false)}
        onPause={() => {
          if (audioRef.current && audioRef.current.currentTime === 0) setPlaying(false);
        }}
      />
    </Card>
  );
}

export default memo(AudioRefCard);

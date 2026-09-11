/**
 * 生成面板「参考区添加」hook：上传素材 -> 新建对应类型节点 -> 自动连到生成节点。
 *
 * 图片 / 视频 / 文本三个生成面板共用，替代原先逐字重复的三份实现。
 * 新节点放在目标节点左侧纵向居中（多个依次向左排开），并由管道的
 * create-node sink 负责占位、进度、失败移除与提示。
 *
 * accept 默认仅图片；文本节点可放开为 "image/*,video/*,audio/*" 以接入多模态参考。
 */
"use client";

import { useCallback } from "react";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

import { pickFiles } from "./pick-files";
import { runMediaUpload } from "./upload-pipeline";

/** 参考节点与生成节点之间的间隙（px） */
const REF_GAP = 50;

export function useRefUpload(nodeId: string, options?: { accept?: string }) {
  const accept = options?.accept ?? "image/*";
  return useCallback(async () => {
    const files = await pickFiles({ accept, multiple: true });
    if (files.length === 0) return;
    if (!useCanvasStore.getState().getNodes().some((n) => n.id === nodeId)) return;

    await runMediaUpload({
      items: files.map((file) => ({ blob: file, filename: file.name })),
      sink: {
        kind: "create-node",
        connectTo: nodeId,
        connectDir: "out",
        anchor: { nodeId, side: "left", gap: REF_GAP },
      },
    });
  }, [nodeId, accept]);
}

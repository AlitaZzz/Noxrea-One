/**
 * 生成面板「参考区添加」hook：上传图片 -> 新建参考节点 -> 自动连到生成节点。
 *
 * 图片 / 视频 / 文本三个生成面板共用，替代原先逐字重复的三份实现。
 * 新节点放在目标节点左侧纵向居中（多个依次向左排开），并由管道的
 * create-node sink 负责占位、进度、失败移除与提示。
 */
"use client";

import { useCallback } from "react";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

import { pickFiles } from "./pick-files";
import { runMediaUpload } from "./upload-pipeline";

/** 参考节点与生成节点之间的间隙（px） */
const REF_GAP = 50;

export function useRefUpload(nodeId: string) {
  return useCallback(async () => {
    const files = await pickFiles({ accept: "image/*", multiple: true });
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
  }, [nodeId]);
}

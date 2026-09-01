/**
 * 节点内上传 hook：把文件原地替换到指定节点（图片 / 视频 / 音频节点共用）。
 *
 * 走统一上传管道的 replace-node sink：上传前记录快照，成功写回 src 与尺寸，
 * 失败回滚并提示，不再由各节点组件各自维护上传态。
 */
"use client";

import { useCallback, useRef } from "react";

import { pickFiles } from "./pick-files";
import { runMediaUpload } from "./upload-pipeline";

export interface NodeUploadOptions {
  /** input 的 accept，如 "image/*" */
  accept: string;
  /** 替换成功后需要从 node.data 清掉的字段（如图片节点的多图结果） */
  clearFields?: readonly string[];
}

/**
 * 返回一个打开系统文件选择器并完成替换上传的回调。
 */
export function useNodeUpload(nodeId: string, options: NodeUploadOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  return useCallback(async () => {
    const { accept, clearFields } = optionsRef.current;
    const files = await pickFiles({ accept });
    if (files.length === 0) return;

    await runMediaUpload({
      items: files.map((file) => ({ blob: file, filename: file.name })),
      sink: { kind: "replace-node", nodeId, clearFields },
    });
  }, [nodeId]);
}

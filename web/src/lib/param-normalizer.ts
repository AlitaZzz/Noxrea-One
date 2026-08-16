/**
 * 视频生成参数归一化器。
 * 职责：把前端面板的零散参数整理成统一结构，并校验 refMode 是否为模型支持的能力。
 * 前端只传有序 refImages[]（含首帧/尾帧），模式由 refMode 声明，后端据此派生首尾帧。
 */
import type { Capability } from "@/lib/types/models";

export type RefMode = "none" | "first" | "first-last" | "full";

export interface NormalizedVideoParams {
  prompt: string;
  ratio: string;
  resolution: string;
  seconds: number;
  generateAudio: boolean;
  /** 参考模式：none/first/first-last/full，空值回落 none（文生视频） */
  refMode: RefMode;
  /** 有序参考图数组（含首帧/尾帧，按用户排序） */
  refImages: string[];
  refVideos: string[];
  refAudios: string[];
}

/**
 * 归一化 + 校验。
 * refMode 必须是模型声明支持的（capabilities.refMode.options），否则回落 "none"（文生）。
 * 模型未声明 refMode 能力时，前端不应渲染该开关。
 */
export function normalizeVideoParams(
  input: Partial<NormalizedVideoParams>,
  capabilities?: Record<string, Capability>
): NormalizedVideoParams {
  const allowed = capabilities?.refMode?.options ?? [];
  const refMode: RefMode = allowed.includes(input.refMode as string)
    ? (input.refMode as RefMode)
    : "none";
  return {
    prompt: input.prompt ?? "",
    ratio: input.ratio ?? "16:9",
    resolution: input.resolution ?? "720p",
    seconds: input.seconds ?? 5,
    generateAudio: input.generateAudio ?? false,
    refMode,
    refImages: input.refImages ?? [],
    refVideos: input.refVideos ?? [],
    refAudios: input.refAudios ?? [],
  };
}
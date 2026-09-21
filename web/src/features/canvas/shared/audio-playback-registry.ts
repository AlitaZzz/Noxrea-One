/**
 * 节点音频播放器注册表。
 *
 * 音频截取面板渲染在画布层，拿不到 AudioWaveform 内部的 wavesurfer 实例，
 * 但需要读取「当前播放位置」作为选区起点、并在截取期间暂停节点播放。
 * 播放进度若写进 store 会随 updateNodeData 进入撤销栈，因此用模块级 Map 做
 * 轻量桥接：不参与渲染、不产生历史记录、实例销毁即注销（与视频注册表同构）。
 */
import type WaveSurfer from "wavesurfer.js";

const registry = new Map<string, WaveSurfer>();

/** 注册节点内的 wavesurfer 实例，返回注销函数（直接交给 useEffect 清理） */
export function registerAudioPlayer(nodeId: string, ws: WaveSurfer): () => void {
  registry.set(nodeId, ws);
  return () => {
    // 仅在仍是同一实例时注销，避免新实例注册后被旧实例的清理误删
    if (registry.get(nodeId) === ws) registry.delete(nodeId);
  };
}

/** 读取当前播放时间；实例未注册时返回 0 */
export function getAudioPlaybackTime(nodeId: string): number {
  const t = registry.get(nodeId)?.getCurrentTime() ?? 0;
  return Number.isFinite(t) ? t : 0;
}

/** 暂停节点播放——截取面板打开期间避免与面板的循环试听双声叠加 */
export function pauseAudio(nodeId: string): void {
  registry.get(nodeId)?.pause();
}

/**
 * 节点音频播放器注册表。
 *
 * 音频截取面板渲染在画布层，拿不到 AudioWaveform 内部的播放元素，
 * 但需要读取「当前播放位置」作为选区起点、并在截取期间暂停节点播放。
 * 播放进度若写进 store 会随 updateNodeData 进入撤销栈，因此用模块级 Map 做
 * 轻量桥接：不参与渲染、不产生历史记录、实例销毁即注销（与视频注册表同构）。
 *
 * 契约是最小播放句柄而不是 wavesurfer 实例：波形只是渲染器，播放由媒体元素
 * 直接支撑，波形不可用时注册与暂停同样有效
 * （specs/canvas-audio-peaks-cache.md 规则 5.2）。
 */
export interface AudioPlaybackHandle {
  getCurrentTime(): number;
  pause(): void;
}

const registry = new Map<string, AudioPlaybackHandle>();

/** 注册节点内的播放句柄，返回注销函数（直接交给 useEffect 清理） */
export function registerAudioPlayer(nodeId: string, handle: AudioPlaybackHandle): () => void {
  registry.set(nodeId, handle);
  return () => {
    // 仅在仍是同一句柄时注销，避免新句柄注册后被旧句柄的清理误删
    if (registry.get(nodeId) === handle) registry.delete(nodeId);
  };
}

/** 读取当前播放时间；未注册时返回 0 */
export function getAudioPlaybackTime(nodeId: string): number {
  const t = registry.get(nodeId)?.getCurrentTime() ?? 0;
  return Number.isFinite(t) ? t : 0;
}

/** 暂停节点播放——截取面板打开期间避免与面板的循环试听双声叠加 */
export function pauseAudio(nodeId: string): void {
  registry.get(nodeId)?.pause();
}

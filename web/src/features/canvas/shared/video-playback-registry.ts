/**
 * 节点视频元素注册表。
 *
 * 帧序列面板（FrameStripPanel）渲染在画布层，拿不到 VideoNode 内部的 videoRef，
 * 但需要读取「当前播放位置」作为播放头初始时间、并在选帧期间暂停节点播放。
 * 播放进度若写进 store 会随 updateNodeData 进入撤销栈，因此用模块级 Map 做
 * 轻量桥接：不参与渲染、不产生历史记录、节点卸载即注销。
 */
const registry = new Map<string, HTMLVideoElement>();

/** 注册节点内 video 元素，返回注销函数（直接交给 useEffect 清理） */
export function registerVideoElement(nodeId: string, el: HTMLVideoElement): () => void {
  registry.set(nodeId, el);
  return () => {
    // 仅在仍是同一元素时注销，避免新元素注册后被旧元素的清理误删
    if (registry.get(nodeId) === el) registry.delete(nodeId);
  };
}

/** 读取当前播放时间；元素未注册或已卸载时返回 0 */
export function getVideoPlaybackTime(nodeId: string): number {
  const v = registry.get(nodeId);
  return v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
}

/** 暂停节点播放——选帧期间避免 hover 播放干扰视觉判断 */
export function pauseVideo(nodeId: string): void {
  const v = registry.get(nodeId);
  if (v && !v.paused) v.pause();
}

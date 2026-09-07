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

/** 节点是否正在播放：面板据此决定播放头是否跟随，暂停时跟随会用滞后位置覆盖用户操作 */
export function isVideoPlaying(nodeId: string): boolean {
  const v = registry.get(nodeId);
  return !!v && !v.paused && !v.ended;
}

/** 暂停节点播放——选帧期间避免 hover 播放干扰视觉判断 */
export function pauseVideo(nodeId: string): void {
  const v = registry.get(nodeId);
  if (v && !v.paused) v.pause();
}

/** 抓取当前帧做封面：换源期间顶住画面，避免 video 短暂空白造成闪烁 */
function captureCurrentFrame(v: HTMLVideoElement): string | null {
  try {
    if (!v.videoWidth || !v.videoHeight) return null;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    // 跨域污染等情况拿不到画面，退回无封面的旧行为
    return null;
  }
}

/**
 * 选帧期间把节点播放器临时切到全 I 帧代理，返回恢复函数（交给 useEffect 清理）。
 *
 * 原视频多为长 GOP，seek 要从 GOP 起点解码过来，拖动时画面只能滞后于播放头；
 * 代理每一帧都独立可解，seek 毫秒级完成，流畅与对齐可以同时拿到。
 *
 * 只改 video 元素的 src，节点数据里的原始 src 不动——保存素材、下载、后端抽帧
 * 出图仍走原视频，不受影响。恢复时会停在代理上的当前时间，也就是用户选中的那一帧。
 */
export function swapVideoSource(nodeId: string, proxySrc: string): () => void {
  const v = registry.get(nodeId);
  if (!v) return () => {};

  const prevSrc = v.getAttribute("src") ?? "";
  let restored = false;

  /** 换源后 metadata 需要重新加载，时间点必须等加载完再写回 */
  const apply = (src: string, time: number) => {
    // 先把当前帧设成封面顶住画面，loadeddata（新视频已有可显示帧）后再撤掉，
    // 否则切换瞬间 video 没有内容可显示，看起来就是闪一下
    const poster = captureCurrentFrame(v);
    if (poster) v.poster = poster;
    const onMeta = () => {
      v.currentTime = time;
    };
    const onData = () => v.removeAttribute("poster");
    v.addEventListener("loadedmetadata", onMeta, { once: true });
    v.addEventListener("loadeddata", onData, { once: true });
    v.src = src;
    v.load();
  };

  apply(proxySrc, v.currentTime);

  return () => {
    if (restored) return;
    restored = true;
    // 用代理上的当前时间回写：用户选到哪一帧，恢复后就停在哪一帧
    apply(prevSrc, v.currentTime);
  };
}

/**
 * 让节点播放器跳到指定时间，用于拖动播放头时的 scrubbing 预览。
 * 时间钳制在 [0, duration-0.05]，与面板截取时的取值保持一致。
 *
 * 这里刻意不等上一次 seek 完成：目标位置连续变化时，解码器会持续解码并呈现
 * 途经的帧，画面是流畅的擦洗效果；改成「等 seeked 再发下一个 seek」后中间
 * 过程不再呈现，画面变成一顿一顿地跳，实测流畅度明显更差，故保持直接下发。
 */
export function seekVideo(nodeId: string, time: number): void {
  const v = registry.get(nodeId);
  if (!v || !Number.isFinite(time)) return;
  // scrubbing 时画面必须静止：拖动途中播放器若被 hover 重新唤起，不能继续走
  if (!v.paused) v.pause();
  const max = Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.05) : time;
  v.currentTime = Math.min(Math.max(0, time), max);
}

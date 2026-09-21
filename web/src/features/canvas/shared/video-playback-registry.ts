/**
 * 节点视频元素注册表。
 *
 * 帧序列面板（FrameStripPanel）渲染在画布层，拿不到 VideoNode 内部的 videoRef，
 * 但需要读取「当前播放位置」作为播放头初始时间、并在选帧期间暂停节点播放。
 * 播放进度若写进 store 会随 updateNodeData 进入撤销栈，因此用模块级 Map 做
 * 轻量桥接：不参与渲染、不产生历史记录、节点卸载即注销。
 */
import { SEEK_MARGIN_S } from "@/lib/constants";

const registry = new Map<string, HTMLVideoElement>();

/**
 * 未注册告警去重：seek 是逐帧调用的高频操作，未注册时不能每帧刷屏。
 * 这类静默失败曾导致「拖动轨道画面不同步、刷新页面才恢复」长时间无法定位，必须留痕。
 */
const unregisteredWarned = new Set<string>();
function warnUnregistered(nodeId: string, op: string): void {
  if (unregisteredWarned.has(nodeId)) return;
  unregisteredWarned.add(nodeId);
  console.warn(
    `[video-registry] ${op}: 节点 ${nodeId} 未注册 video 元素（多见于条件渲染分支切换导致漏注册）`,
  );
}

/** 注册节点内 video 元素，返回注销函数（直接交给 useEffect 清理） */
export function registerVideoElement(nodeId: string, el: HTMLVideoElement): () => void {
  registry.set(nodeId, el);
  unregisteredWarned.delete(nodeId);
  // 元素可能在面板打开期间被重挂（条件渲染分支切换）：按登记表补挂面板已
  // 注册的 ended 监听，否则监听留在游离元素上，ended 事件再也到不了面板
  endedListeners.get(nodeId)?.forEach((h) => el.addEventListener("ended", h));
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

/** 播放节点视频——片段截取面板用它循环预览。返回 play() 的 promise（未注册时
    为 undefined）；策略拒绝由调用方经 usePlaybackBlocked 转成恢复提示。
    不加 paused 守卫：自然 ended 与 NotAllowedError 拒绝后 paused 都仍是 false
    （规范只让 pause() 置位），守卫会把这两种状态的续播/重试短路成空操作——
    元素停在「paused=false 却不推进」的死态，面板内再无恢复路径。
    对已在播放的元素调用 play() 是规范定义的无操作（promise 直接 resolve） */
export function playVideo(nodeId: string): Promise<void> | undefined {
  const v = registry.get(nodeId);
  if (!v) return undefined;
  return v.play();
}

/** 只改播放时间、不改变播放/暂停状态。两个用途：循环回跳（seekVideo 会
    pause，用它做回跳会把循环播停成一圈就停）、键盘微调恢复播放后的重新定位
    （seekVideo 的 pause 会把刚恢复的播放在下一帧按停）。
    上钳 duration - SEEK_MARGIN_S（与 seekVideo 一致）：设到精确时长构成
    ended playback，随后的 play() 会按规范跳回文件开头（开头闪帧） */
export function setVideoTime(nodeId: string, time: number): void {
  const v = registry.get(nodeId);
  if (!v || !Number.isFinite(time)) return;
  const max = Number.isFinite(v.duration) && v.duration > 0 ? Math.max(0, v.duration - SEEK_MARGIN_S) : time;
  v.currentTime = Math.min(Math.max(0, time), max);
}

/**
 * ended 监听器登记表：onVideoEnded 的监听必须跟着「当前注册的元素」走——
 * video 元素在面板打开期间可能被重挂（同 nodeId 换新元素），快照式绑定会把
 * 监听留在游离元素上导致 ended 永久丢失，元素注册时按此表补挂。
 */
const endedListeners = new Map<string, Set<() => void>>();

/** 监听节点视频自然播完（ended）。截取面板的选区出点在文件末尾时，ended 置位
    先于 rAF 观察到「播放位置越过出点」——isVideoPlaying 在 ended 瞬间已为
    false，循环 tick 永远看不到越界，只能靠此事件把循环续上 */
export function onVideoEnded(nodeId: string, handler: () => void): () => void {
  let listeners = endedListeners.get(nodeId);
  if (!listeners) {
    listeners = new Set();
    endedListeners.set(nodeId, listeners);
  }
  listeners.add(handler);
  const v = registry.get(nodeId);
  if (!v) {
    // 静默空转会让出点在文件末尾的循环在 ended 后永久停住，必须留痕；
    // 元素随后注册时 registerVideoElement 会按登记表补挂
    warnUnregistered(nodeId, "onVideoEnded");
  } else {
    v.addEventListener("ended", handler);
  }
  return () => {
    listeners.delete(handler);
    if (listeners.size === 0) endedListeners.delete(nodeId);
    registry.get(nodeId)?.removeEventListener("ended", handler);
  };
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
 * 选帧期间把节点播放器临时切到预览代理，返回恢复函数（交给 useEffect 清理）。
 *
 * 原视频多为长 GOP，seek 要从 GOP 起点解码过来，拖动时画面只能滞后于播放头；
 * 代理是低分辨率短 GOP 副本，seek 最多解码 1 秒画面，流畅与对齐可以同时拿到。
 *
 * 只改 video 元素的 src，节点数据里的原始 src 不动——保存素材、下载、后端抽帧
 * 出图仍走原视频，不受影响。恢复时会停在代理上的当前时间，也就是用户选中的那一帧。
 *
 * resume：换源默认停在暂停态（帧序列面板本来就是暂停 scrub）；片段截取面板
 * 在循环预览中换源，需要元数据就绪后自动续播，由该开关控制。
 *
 * onReady：换入的代理达到可流畅播放（canplay）时以 true 回调一次——片段截取
 * 面板用它在缓冲就绪后再解锁交互（首次打开时代理刚生成、浏览器缓存全冷，立即
 * 拖动会触发一串 Range 拉取 + 解码，跟不上指针）。监听挂在本函数内部，
 * 保证等待的是换入的代理而不是换源前的旧元素（旧元素早已就绪，会造成
 * 闸门被立即满足、冷缓存保护失效）；代理加载失败以 false 回调——既避免面板
 * 永久冻结，也让调用方与请求期失败同样落入「面板禁用、重开重试」路径
 * （浏览器解码不了代理文件时 error 与 canplay 一样不会来，只无条件解锁会
 * 得到一个画面冻结但可操作的活死人面板）。
 */
export function swapVideoSource(
  nodeId: string,
  proxySrc: string,
  opts?: { resume?: boolean; onReady?: (ok: boolean) => void },
): () => void {
  const v = registry.get(nodeId);
  if (!v) {
    // 空转会让播放器继续用原视频（长 GOP），拖轨道时画面与轨道不同步
    warnUnregistered(nodeId, "swapVideoSource");
    return () => {};
  }

  const prevSrc = v.getAttribute("src") ?? "";
  const resume = opts?.resume === true;
  const onReady = opts?.onReady;
  let restored = false;
  /** 换源监听器的清理函数：换回原视频时移除上一轮尚未触发的监听 */
  let lastCleanup: (() => void) | null = null;

  /**
   * 换源后 metadata 需要重新加载，时间点必须等加载完再写回。
   * shouldResume / readyCallback 只在换入代理时生效：恢复原视频（面板关闭）
   * 永远保持暂停、也不触发 onReady，否则会违背用户意图地自动播放。
   */
  const apply = (src: string, time: number, shouldResume: boolean, readyCallback?: (ok: boolean) => void) => {
    // 先把当前帧设成封面顶住画面，loadeddata（新视频已有可显示帧）后再撤掉，
    // 否则切换瞬间 video 没有内容可显示，看起来就是闪一下
    const poster = captureCurrentFrame(v);
    if (poster) v.poster = poster;
    const onMeta = () => {
      v.currentTime = time;
      if (shouldResume) void v.play().catch(() => undefined);
    };
    const onData = () => v.removeAttribute("poster");
    // onReady 只回调一次：canplay 与 error 都是 { once: true }，但两者互不摘除——
    // 若不加 settled 门闩，canplay 解锁面板后残留的 error 监听会在会话中途
    // （如代理文件被截断/损坏区域解码失败）触发 onReady(false)，把一个正在
    // 正常工作的面板整体打成 failed 禁用态。晚到的致命错误按旧契约忽略：
    // 抽帧/截取走的是服务端原视频，代理死掉只影响预览流畅度，不该禁用确认
    let readySettled = false;
    const fireReady = (ok: boolean) => {
      if (readySettled) return;
      readySettled = true;
      readyCallback?.(ok);
    };
    const onCanPlay = () => fireReady(true);
    const onLoadError = () => fireReady(false);
    const cleanup = () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("loadeddata", onData);
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("error", onLoadError);
    };
    v.addEventListener("loadedmetadata", onMeta, { once: true });
    v.addEventListener("loadeddata", onData, { once: true });
    // canplay / error 都触发 readyCallback（ok 区分）：前者正常解锁，后者避免
    // 面板冻结且让面板落到禁用态而不是解锁一个解码不了的死播放器
    if (readyCallback) {
      v.addEventListener("canplay", onCanPlay, { once: true });
      v.addEventListener("error", onLoadError, { once: true });
    }
    v.src = src;
    v.load();
    return cleanup;
  };

  lastCleanup = apply(proxySrc, v.currentTime, resume, onReady);

  return () => {
    if (restored) return;
    restored = true;
    // 用代理上的当前时间回写：用户选到哪一帧，恢复后就停在哪一帧
    lastCleanup?.();
    apply(prevSrc, v.currentTime, false);
  };
}

/**
 * 让节点播放器跳到指定时间，用于拖动播放头时的 scrubbing 预览。
 * 时间钳制在 [0, duration-SEEK_MARGIN_S]，与面板截取时的取值保持一致。
 *
 * 这里刻意不等上一次 seek 完成：目标位置连续变化时，解码器会持续解码并呈现
 * 途经的帧，画面是流畅的擦洗效果；改成「等 seeked 再发下一个 seek」后中间
 * 过程不再呈现，画面变成一顿一顿地跳，实测流畅度明显更差，故保持直接下发。
 */
export function seekVideo(nodeId: string, time: number): void {
  const v = registry.get(nodeId);
  if (!v) {
    warnUnregistered(nodeId, "seekVideo");
    return;
  }
  if (!Number.isFinite(time)) return;
  // scrubbing 时画面必须静止：拖动途中播放器若被 hover 重新唤起，不能继续走
  if (!v.paused) v.pause();
  // duration>0 才上钳（与 setVideoTime 一致）：duration 为 0 时钳成 max(0, -margin)
  // 会把任何目标时间都压到 0，scrub 全程停在开头
  const max = Number.isFinite(v.duration) && v.duration > 0 ? Math.max(0, v.duration - SEEK_MARGIN_S) : time;
  v.currentTime = Math.min(Math.max(0, time), max);
}

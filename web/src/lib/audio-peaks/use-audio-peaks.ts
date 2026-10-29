/**
 * 音频峰值 Hook（specs/canvas-audio-peaks-cache.md 规则 1 / 4.6）。
 *
 * 首帧同步读内存缓存（已解过的文件不闪占位），未命中再异步取数；
 * 换源时旧结果立即失效，不会短暂显示上一条音频的波形。
 *
 * 卸载不取消在途解码（规则 1.5）：结果会入缓存给其他消费者复用，
 * 取消会波及同时挂载的节点与截取面板。
 */
"use client";

import { useEffect, useState } from "react";

import {
  type AudioPeaks,
  type AudioPeaksResult,
  getAudioPeaks,
  peekAudioPeaks,
  peekAudioPeaksFailure,
  touchAudioPeaks,
} from "./index";

export interface AudioPeaksState {
  /** 峰值；`status` 非 ready 时为 null。视为不可变，交给渲染层前自行复制 */
  peaks: AudioPeaks | null;
  /**
   * 时长（秒）：ready 时来自 `AudioBuffer.duration`；unavailable 时可能来自
   * 元数据探测（超限 / 字节超限 / 解码失败都有值），用于回填节点时长（规则 5.3）
   */
  duration: number | null;
  status: "loading" | "ready" | "unavailable";
}

const LOADING: AudioPeaksState = { peaks: null, duration: null, status: "loading" };

const readyState = (peaks: AudioPeaks): AudioPeaksState => ({
  peaks,
  duration: peaks.duration,
  status: "ready",
});

/** 服务层结果 → Hook 状态；不可用原因只用于服务层的失败记忆与诊断，渲染方不需要它 */
const stateOf = (result: AudioPeaksResult): AudioPeaksState => (
  result.status === "ready"
    ? readyState(result.peaks)
    : { peaks: null, duration: result.duration, status: "unavailable" }
);

/** 结果连同所属引用值一起存：换源后旧结果靠这个标记失效 */
interface PeaksEntry {
  source: string;
  state: AudioPeaksState;
  /**
   * 状态来自渲染期的内存缓存探测。渲染期只能纯读，命中后的使用时刻必须由提交阶段
   * 补记（规则 3.4）；服务路径（IndexedDB 命中 / 解码完成）自己记账，不重复
   */
  fromMemory: boolean;
}

/**
 * 订阅一条逻辑引用值的峰值。
 * `value` 为空时保持 loading 且不发请求（调用方本就不该渲染波形）。
 */
export function useAudioPeaks(value: string | null | undefined): AudioPeaksState {
  const [entry, setEntry] = useState<PeaksEntry>({ source: "", state: LOADING, fromMemory: false });

  // 缓存命中在渲染期直接生效：已解过的文件首帧即出波形、已确认不可解的托管值首帧
  // 即落为不可用，都不闪一帧占位；也避免在 effect 里同步 setState 引发级联渲染
  // （与 use-file-access-url 同款）
  if (value && entry.source !== value) {
    const cached = peekAudioPeaks(value);
    if (cached) {
      setEntry({ source: value, state: readyState(cached), fromMemory: true });
    } else {
      const remembered = peekAudioPeaksFailure(value);
      if (remembered) setEntry({ source: value, state: stateOf(remembered), fromMemory: false });
    }
  }

  useEffect(() => {
    if (!value || entry.source !== value || !entry.fromMemory) return;
    // 渲染期探测保持纯读，命中的使用时刻在这里补记：只在服务入口记账会让首帧命中
    // 内存的常用文件永远停留在解码时刻（规则 3.4）
    touchAudioPeaks(value);
  }, [value, entry.source, entry.fromMemory]);

  useEffect(() => {
    if (!value || entry.source === value) return;
    let cancelled = false;
    void getAudioPeaks(value).then((result) => {
      // 订阅随组件卸载 / 换源解除（规则 1.5）：解码本身继续跑完并入库
      if (cancelled) return;
      setEntry({ source: value, state: stateOf(result), fromMemory: false });
    });
    return () => {
      cancelled = true;
    };
  }, [value, entry.source]);

  return entry.source === value ? entry.state : LOADING;
}

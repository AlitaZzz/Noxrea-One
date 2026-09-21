/**
 * 截取面板（视频 / 音频）共用的「自动播放被拦截」状态机。
 *
 * init 的自动 play() 被浏览器策略拒绝时置位，面板亮出恢复提示；keydown 与
 * pointerdown 同为有效的用户激活，下一次真实手势调用 resumeIfBlocked 重试
 * 播放。二次拒绝仍可能发生（如跨域 iframe 未授权 autoplay）：置回 blocked
 * 让提示继续显示，而不是静默吞掉。
 *
 * play() 的其他拒绝不算拦截：pending promise 被 pause() 打断的 AbortError
 * 在 scrub 流程里很常见，媒体错误各有专路径提示——只认 NotAllowedError，
 * 避免拖动中误亮「自动播放被拦截」。
 */
"use client";

import { useCallback, useState } from "react";

export default function usePlaybackBlocked(play: () => Promise<unknown> | undefined) {
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  /** 清除拦截标记并重试播放；再被策略拒绝则重新置位（ended/init 的无条件续播走这里）。
      play() 没产生 promise（video 元素未注册 / wavesurfer 未就绪）时恢复无法发生：
      必须保持置位——清掉标记会让后续 resumeIfBlocked 全部短路，面板生命周期内
      再无恢复路径，播放静默丢失且无任何提示 */
  const resume = useCallback(() => {
    const p = play();
    if (!p) {
      setPlaybackBlocked(true);
      return;
    }
    setPlaybackBlocked(false);
    p.catch((err: unknown) => {
      if ((err as DOMException | undefined)?.name === "NotAllowedError") {
        setPlaybackBlocked(true);
      }
    });
  }, [play]);
  /** 被拦截时才恢复：真实手势（轨道按下/方向键/拖动）顺带续播用 */
  const resumeIfBlocked = useCallback(() => {
    if (playbackBlocked) resume();
  }, [playbackBlocked, resume]);
  return { playbackBlocked, resume, resumeIfBlocked };
}

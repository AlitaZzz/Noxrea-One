/**
 * 托管音频的播放元素（specs/canvas-audio-peaks-cache.md 规则 4.2 / 4.3 / 4.7 / 4.8）。
 *
 * 元素由组件命令式创建并持有：不进入 React 渲染树、不挂进 DOM（`<audio>` 脱离文档
 * 仍可播放）。因此它放在 ref 而不是 state——元素属于外部系统，React 不拥有它的
 * 生命周期，`src` / `currentTime` 的写入是「用最新状态更新外部系统」而不是状态变更。
 *
 * 地址只在换源、重新描述得到新地址、`reloadToken` 变化时同步到元素；波形实例与解码
 * 都不经过这里，因此签名地址轮换不影响它们（规则 4.3）。
 */
"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { detachMediaSource } from "@/lib/media-element";
import { useFileAccessUrl } from "@/lib/use-file-access-url";

export interface AudioElementHandle {
  /** 播放元素：effect 中创建，首帧渲染时为 null，挂载期内身份不变 */
  mediaRef: RefObject<HTMLAudioElement | null>;
  /**
   * 当前应挂到元素上的访问地址；地址未解析出来（或换源后尚未就绪）时为 null。
   * 元素没有地址时 `play()` 只会被以 `NotSupportedError` 拒绝——调用方的
   * 「可播放」判断必须包含它，否则播放按钮亮着却不出声
   */
  src: string | null;
  /** 当前地址下元素加载失败（已按规则 4.7 重新描述一次仍失败） */
  mediaFailed: boolean;
  /** 访问地址描述失败：手动重试入口见 `refresh` */
  accessFailed: boolean;
  /** 跳过缓存重新描述访问地址 */
  refresh: () => Promise<string | undefined>;
  /**
   * 读取元素当前播放时间；元素尚未创建时为 null。身份稳定（只随 `mediaRef` 变化），
   * 可直接作为 `useMediaProgress` 的时间源——读取函数身份变化会被视为换源。
   */
  readTime: () => number | null;
}

/** 已应用到元素上的逻辑源、地址与重挂令牌：地址同步与失败记账共用这份事实 */
interface AppliedSource {
  source: string;
  src: string | null;
  reload: number;
}

/** 失败记账的坐标：地址 + 重挂令牌；换源、换址或重挂后自动失效 */
type FailedCoordinates = Pick<AppliedSource, "src" | "reload">;

export function useAudioElement(value: string): AudioElementHandle {
  const { url, failed: accessFailed, refresh, retrySigned, reloadToken } = useFileAccessUrl(value);
  const mediaRef = useRef<HTMLAudioElement | null>(null);
  const appliedRef = useRef<AppliedSource>({
    source: "",
    src: null,
    reload: -1,
  });
  // 失败按「地址 + 重挂令牌」记账：换源、重新描述得到新地址、重挂令牌变化都让旧失败态
  // 自动失效，不必在 effect 里同步复位（那会引发级联渲染）
  const [failedAt, setFailedAt] = useState<FailedCoordinates | null>(null);
  // 规则 4.7 的重试预算：一次加载失败只重描述一次。按逻辑源记账而不是按签名地址
  // ——服务端每次都会签出新地址，按地址记账会无限重试；加载成功或换源后重新武装
  const retriedRef = useRef<string | null>(null);

  const src = url ?? null;
  const mediaFailed = failedAt !== null && failedAt.src === src && failedAt.reload === reloadToken;

  // retrySigned 的身份随解析状态变化（每次重新描述都会换新），onError 里用 ref 取
  // 最新值；重试预算由本 Hook 按逻辑源维护（规则 4.7），useFileAccessUrl 另有一层
  // 按失败签名地址的预算（规则 3.6）
  const retrySignedRef = useRef(retrySigned);
  useEffect(() => {
    retrySignedRef.current = retrySigned;
  }, [retrySigned]);

  useEffect(() => {
    const element = document.createElement("audio");
    element.preload = "metadata";
    mediaRef.current = element;
    // 新元素没有挂过任何地址：同步 effect 必须重新赋值（StrictMode 双挂载时
    // 「地址没变」是上一个元素的既成事实，照搬会让新元素永远没有 src）
    appliedRef.current = { source: "", src: null, reload: -1 };
    retriedRef.current = null;
    // 规则 4.7：元素失败先重新描述一次，仍失败才进入失败态。不能在 error 事件里
    // 直接置位——覆盖层会在重新描述期间闪烁，而签名过期本来就能靠重描述恢复
    const onError = () => {
      const applied = appliedRef.current;
      // 没挂过地址的 error 不是加载失败
      if (applied.src === null) return;
      if (retriedRef.current === applied.source) {
        setFailedAt({ src: applied.src, reload: applied.reload });
        return;
      }
      retriedRef.current = applied.source;
      const fail = () => {
        const current = appliedRef.current;
        // 期间换源 / 换址 / 重挂：这次失败不属于当前状态
        if (
          current.source !== applied.source ||
          current.src !== applied.src ||
          current.reload !== applied.reload
        ) {
          return;
        }
        setFailedAt({ src: applied.src, reload: applied.reload });
      };
      // 返回新地址（或同一地址的新重挂令牌）时元素会重新加载，失败态不成立；
      // 返回 null 说明拿不到新地址（stream / 外部地址 / 预算耗尽）——仍失败
      void retrySignedRef.current().then((url) => {
        if (url === null) fail();
      }, fail);
    };
    // 元数据加载成功即证明当前地址可用：失败态在这里收敛，并为下一次过期重新武装
    // 一次重描述。否则一次排队中的旧地址 error 恰好落在换址之后，会把新地址误记为
    // 失败，而新地址本身加载成功却没有任何事件能清掉它
    const onLoadedMetadata = () => {
      retriedRef.current = null;
      setFailedAt(null);
    };
    element.addEventListener("error", onError);
    element.addEventListener("loadedmetadata", onLoadedMetadata);
    return () => {
      element.removeEventListener("error", onError);
      element.removeEventListener("loadedmetadata", onLoadedMetadata);
      mediaRef.current = null;
      // wavesurfer 的 destroy 对外部元素只解绑事件、不暂停也不移除（规则 4.8）：
      // 不在这里收尾会让节点删除后音频继续播放
      element.pause();
      detachMediaSource(element);
    };
  }, []);

  useEffect(() => {
    const element = mediaRef.current;
    if (!element) return;
    const applied = appliedRef.current;
    const sameSource = applied.source === value;
    if (sameSource && applied.src === src && applied.reload === reloadToken) return;
    // 换源是新的失败回合：新逻辑源重新拥有一次重描述预算
    if (!sameSource) retriedRef.current = null;
    appliedRef.current = { source: value, src, reload: reloadToken };
    if (!src) {
      // 地址不可用（换源后尚未就绪，或会话切换作废旧作用域）：上一段音频不能继续
      // 留在元素上，否则旧账号的音频会在登出后继续播放。从未挂过地址时无事可做
      if (applied.src !== null) detachMediaSource(element);
      return;
    }
    // 同一元素同一地址（重新签出未变）只需强制重载；新地址由 src 赋值自动触发加载
    if (sameSource && applied.src === src) element.load();
    else element.src = src;
  }, [value, src, reloadToken]);

  // 播放进度的时间源：媒体元素由本 Hook 持有，读取语义与身份稳定性也只在这里定义，
  // 消费方不再各自复制一份 `currentTime ?? null`
  const readTime = useCallback(() => mediaRef.current?.currentTime ?? null, [mediaRef]);

  return { mediaRef, src, mediaFailed, accessFailed, refresh, readTime };
}

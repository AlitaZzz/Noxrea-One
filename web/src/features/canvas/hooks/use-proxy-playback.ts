/**
 * 预览代理的播放就绪度。
 *
 * useVideoProxy 只负责「产物可下载」（ready + url）；代理刚生成时浏览器缓存
 * 全冷，立即拖动会触发一串 Range 拉取 + 解码，跟不上指针。本 hook 在代理就绪
 * 后把它换到节点播放器，等换入的元素真正 canplay 才视为可播放。监听由
 * swapVideoSource 内部挂载，等待的必然是换入的代理而不是换源前的旧元素。
 *
 * 浏览器解码不了代理文件时 canplay 永远不来，按 error 回调标为失败——重开面板
 * 重试，不把面板留在「画面冻死但可操作」的状态。buffer 记录就绪的是哪一条代理
 * 地址：换源后旧地址的就绪状态自动失效，无需在 effect 里同步重置（那会触发
 * 级联渲染）；同一地址重试时旧值也已被失败态挡住。
 */
"use client";

import { useEffect, useState } from "react";

import { isVideoPlaying, swapVideoSource } from "@/features/canvas/shared/video-playback-registry";

import { useVideoProxy, type VideoProxyState } from "./use-video-proxy";

interface ProxyPlayback extends VideoProxyState {
  /** 代理可下载且浏览器已缓冲：面板可以解锁 scrub / 循环预览 */
  playable: boolean;
  retry: () => void;
}

export function useProxyPlayback(nodeId: string, videoRef: string): ProxyPlayback {
  const proxy = useVideoProxy(videoRef);
  const { status, url, markFailed } = proxy;
  const [buffer, setBuffer] = useState<{ url: string; ready: boolean } | null>(null);

  useEffect(() => {
    if (status !== "ready" || !url) return;
    return swapVideoSource(nodeId, url, {
      // 换源发生在播放中途时续播（片段面板的循环预览、帧面板的边听边找）；
      // 暂停中的换源保持暂停
      resume: isVideoPlaying(nodeId),
      onReady: (ok) => {
        setBuffer({ url, ready: ok });
        if (!ok) markFailed();
      },
    });
  }, [nodeId, status, url, markFailed]);

  const bufferReady = url !== null && buffer?.url === url && buffer.ready;
  return {
    ...proxy,
    playable: status === "ready" && url !== null && bufferReady,
  };
}

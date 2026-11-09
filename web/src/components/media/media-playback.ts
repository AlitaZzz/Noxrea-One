/**
 * 播放镜像状态（`useElementMirror` 的领域类型面）。
 *
 * 视频节点、音频参考卡片与预览播放器共用同一份播放态定义：各处自行声明会漂移成
 * 多份「空闲播放态」，镜像复位语义随之分裂——某个组件把空闲态改成「保留进度」时，
 * 其余组件不会跟着变，而它们说的是同一条规则。
 */

import type { MediaPlaybackMirror } from "@/lib/use-media-playback-mirror";

/** 播放态镜像：只承载跨元素重挂需要保真的播放语义 */
export interface PlaybackMirror {
  playing: boolean;
}

/**
 * 模块级常量保证引用稳定（`useElementMirror` 的 `initial` 契约——它参与 `patch`
 * 的依赖，每次渲染新建对象会让 `patch` 不断换身份）。
 */
export const IDLE_PLAYBACK: PlaybackMirror = { playing: false };

/**
 * 空闲播放态（带进度）：在基本空闲态之上把进度与时长归零，派生而非另立一份。
 * 形状即 `useMediaPlaybackMirror` 的镜像契约，两者不会漂移
 */
export const IDLE_PROGRESS_PLAYBACK: MediaPlaybackMirror = {
  ...IDLE_PLAYBACK,
  progress: 0,
  duration: 0,
};

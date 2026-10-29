/**
 * 音频组件测试的公共夹具：峰值身份、命令式播放元素捕获、jsdom 媒体桩。
 *
 * 组件通过 `document.createElement("audio")` 创建播放元素、不挂进 DOM，测试只能
 * 在创建时捕获；两个组件测试与播放元素 Hook 测试共用同一套媒体桩，避免各自维护
 * 一份逐渐漂移的实现。
 */
import { vi } from "vitest";

import type { AudioPeaksState } from "@/lib/audio-peaks/use-audio-peaks";

/** 峰值身份稳定：每次渲染返回新对象会让波形实例被反复重建 */
export const TEST_PEAKS = {
  channels: [new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])],
  duration: 19,
};

/** 峰值未就绪：实例不创建，播放按钮按「时长未知」处理 */
export const LOADING_PEAKS: AudioPeaksState = { peaks: null, duration: null, status: "loading" };

/** 峰值就绪：波形实例按 `TEST_PEAKS` 创建，时长可直接使用 */
export const READY_PEAKS: AudioPeaksState = {
  peaks: TEST_PEAKS,
  duration: TEST_PEAKS.duration,
  status: "ready",
};

/**
 * 捕获组件命令式创建的 `<audio>`。必须在 `vi.restoreAllMocks()` 之后调用，否则
 * 绑定到的是上一条用例的 spy；调用方在 beforeEach 里重置自己的捕获变量。
 */
export function spyOnCreatedMedia(onCreate: (media: HTMLAudioElement) => void): void {
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const element = createElement(tag);
    if (tag === "audio") onCreate(element as HTMLAudioElement);
    return element;
  }) as typeof document.createElement);
}

/** jsdom 的媒体元素不实现加载与播放：桩掉避免噪音并便于断言重载 */
export function stubMediaElementMethods(): void {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
}

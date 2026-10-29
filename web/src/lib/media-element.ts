/**
 * 媒体元素收尾（specs/canvas-audio-peaks-cache.md 规则 4.8）。
 *
 * `removeAttribute("src")` 只解绑地址，解码器仍可能持有连接并继续缓冲；必须紧跟
 * `load()` 才真正中止在途网络请求。探测元素收尾、播放元素换源 / 登出与卸载清理
 * 都是这条规则，集中在这里；需要停止播放的调用方先自行 `pause()`。
 */
export function detachMediaSource(element: HTMLMediaElement): void {
  element.removeAttribute("src");
  element.load();
}

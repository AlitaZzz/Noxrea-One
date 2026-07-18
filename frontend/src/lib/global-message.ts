/**
 * 全局消息 API — 在 React 组件外也能调用 antd message。
 *
 * 使用方式：
 * 1. App 初始化时将 useMessage hook 返回的 api 注册进来
 * 2. 任意位置调 showGlobalMessage().error("...")
 */

type MessageApi = { error: (msg: string) => void };

let _msgApi: MessageApi | null = null;

export function setGlobalMessageApi(api: MessageApi) {
  _msgApi = api;
}

export function showGlobalMessage(): MessageApi {
  return _msgApi ?? { error: (msg: string) => alert(msg) };
}

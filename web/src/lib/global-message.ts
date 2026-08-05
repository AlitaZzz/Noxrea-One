/**
 * 全局消息 API - 在 React 组件外也能调用 antd message（top tips）。
 *
 * 使用方式：
 * 1. App 初始化时将 App.useApp() 返回的 message 实例注册进来（见 app-providers.tsx）
 * 2. 任意位置调 showGlobalMessage().error("...") / .success("...")
 *
 * 若尚未注册（极早时机），fallback 到 antd 静态 message，避免原生 alert 弹窗。
 */
import { message as antdMessage } from "antd";

type MessageApi = {
  error: (msg: string) => void;
  success: (msg: string) => void;
  info: (msg: string) => void;
  warning: (msg: string) => void;
};

let _msgApi: MessageApi | null = null;

export function setGlobalMessageApi(api: MessageApi) {
  _msgApi = api;
}

export function showGlobalMessage(): MessageApi {
  return (
    _msgApi ?? {
      error: (msg: string) => antdMessage.error(msg),
      success: (msg: string) => antdMessage.success(msg),
      info: (msg: string) => antdMessage.info(msg),
      warning: (msg: string) => antdMessage.warning(msg),
    }
  );
}

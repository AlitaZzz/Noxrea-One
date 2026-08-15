/**
 * 全局通知 API - 在 React 组件外也能调用 antd notification（右下角卡片）。
 *
 * 使用方式：
 * 1. App 初始化时将 App.useApp() 返回的 notification 实例注册进来（见 app-providers.tsx）
 * 2. 任意位置调 showGlobalNotification().error({ title, description })
 *
 * 若尚未注册（极早时机），fallback 到 antd 静态 notification。
 */
import { notification as antdNotification } from "antd";

type NotificationApi = {
  error: (opts: { title: string; description?: string; placement?: "bottomRight"; duration?: number }) => void;
  success: (opts: { title: string; description?: string; placement?: "bottomRight"; duration?: number }) => void;
  info: (opts: { title: string; description?: string; placement?: "bottomRight"; duration?: number }) => void;
  warning: (opts: { title: string; description?: string; placement?: "bottomRight"; duration?: number }) => void;
};

let _notifApi: NotificationApi | null = null;

export function setGlobalNotificationApi(api: NotificationApi) {
  _notifApi = api;
}

function adapt(instance: typeof antdNotification): NotificationApi {
  return {
    error: (o) => instance.error({ message: o.title, description: o.description, placement: o.placement ?? "bottomRight", duration: o.duration }),
    success: (o) => instance.success({ message: o.title, description: o.description, placement: o.placement ?? "bottomRight", duration: o.duration }),
    info: (o) => instance.info({ message: o.title, description: o.description, placement: o.placement ?? "bottomRight", duration: o.duration }),
    warning: (o) => instance.warning({ message: o.title, description: o.description, placement: o.placement ?? "bottomRight", duration: o.duration }),
  };
}

export function showGlobalNotification(): NotificationApi {
  return (
    _notifApi ?? adapt(antdNotification)
  );
}
